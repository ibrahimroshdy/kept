/**
 * The ⌘K command palette (screens §5 Search, frame 04 · 2; D24, D42): search as you type, jump to
 * a location or place, and a few actions, all by keyboard. The frame is React Aria's modal Dialog
 * (focus trapped, Escape closes, focus returns to where it was). Inside is an ARIA 1.2 combobox
 * with an always-open listbox: the input keeps focus, ↑↓ move the active option
 * (aria-activedescendant), Enter opens it, a click does too.
 *
 * Why not React Aria's ComboBox, as the plan says: its list lives in a popover that opens and
 * closes, the wrong shape for a palette. Its Autocomplete is the right shape, but under test its
 * virtual focus never moved on ↑↓, so keyboard operation couldn't be proven; this is the same
 * pattern written out, about sixty lines.
 *
 * - Things come from the server's search (debounced 150 ms, `kind=things&limit=8`), with their
 *   paths and ID chips, words marked as on the search page.
 * - Locations and places are matched here, against the place trees already loaded for the move
 *   picker (`normalize` from @kept/shared, so Arabic folds the same way as the server's search).
 * - Actions: Search for the words, Add a thing (the create sheet), Activity, Trash, Settings.
 * - Ask the assistant: hands the words typed so far to the assistant (assistant/open.ts, D42).
 */
import { normalize, stripPrefixes } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import type { ThingRow } from '@/api/inventory/types';
import { useLocations, useMe } from '@/api/queries';
import { useOpenAssistant } from '@/assistant/open';
import {
  ActivityIcon,
  AssistantIcon,
  GearIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { KindIcon } from '@/components/kind-icon';
import { useAllPlaceTrees } from '@/components/places/api';
import { placeIcon, usePlaceName } from '@/components/places/labels';
import { StatusPill } from '@/components/status-pill';
import { TypeIcon } from '@/components/type-icon';
import { CloseOnBack } from '@/components/ui/close-on-back';
import { addressOf } from '@/lib/address';
import { sep } from '@/lib/format';
import { useKeyHints } from '@/lib/key-hints';
import { useLocationName } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { usePaletteSearch } from './api';
import { Marked, queryForms } from './results';

const DEBOUNCE_MS = 150;
const MAX_PLACES = 5;

type Entry =
  | { id: string; kind: 'thing'; thing: ThingRow }
  | { id: string; kind: 'place'; placeId: string; name: string; path: string; icon: string }
  | { id: string; kind: 'location'; locationId: string; name: string; locKind: string }
  | { id: string; kind: 'action'; label: string; icon: ReactNode; run: () => void; hint?: string };

/** Whether `name` matches `q` the way search does: each word of q starts some word of name. */
function nameMatches(name: string, q: string): boolean {
  const words = normalize(name).split(/[\s›,.·-]+/);
  const all = new Set([...words, ...words.map((w) => stripPrefixes(w))]);
  const qs = normalize(q).split(' ').filter(Boolean);
  return (
    qs.length > 0 &&
    qs.every((w) => [...all].some((x) => x.startsWith(w) || x.startsWith(stripPrefixes(w))))
  );
}

export default function Palette({
  onClose,
  onAddThing,
}: {
  onClose: () => void;
  /** "Add a thing": the host closes the palette and opens the create sheet in this location. */
  onAddThing?: (locationId: string) => void;
}) {
  const { t } = useLingui();
  // The "esc" and ↑↓ ↵ hints only where there are keys (lib/key-hints.ts).
  const keyHints = useKeyHints();
  const placeName = usePlaceName();
  const navigate = useNavigate();
  const openAssistant = useOpenAssistant();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const me = useMe();
  const locations = useLocations();
  const nameOf = useLocationName();
  const { trees } = useAllPlaceTrees();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const search = usePaletteSearch(q);
  const things = q ? (search.data?.things.items ?? []) : [];
  const forms = queryForms(q);

  const go = (to: () => void) => {
    onClose();
    to();
  };

  // ----- entries -----
  const locs = locations.data ?? [];
  const locationEntries: Entry[] = locs
    .filter((l) => (q ? nameMatches(nameOf(l), q) : true))
    .map((l) => ({
      id: `loc:${l.id}`,
      kind: 'location' as const,
      locationId: l.id,
      name: nameOf(l),
      locKind: l.kind,
    }));
  const placeEntries: Entry[] = q
    ? trees
        .flatMap((tr) => {
          const byId = new Map(tr.places.map((pl) => [pl.id, pl]));
          const loc = locs.find((l) => l.id === tr.location.id);
          const where = loc ? nameOf(loc) : tr.location.name;
          return tr.places
            .filter((pl) => !pl.isUnplaced && nameMatches(pl.name, q))
            .map((pl) => {
              const up: string[] = [where];
              const chain: string[] = [];
              for (let cur = byId.get(pl.parentId ?? ''); cur; cur = byId.get(cur.parentId ?? ''))
                chain.unshift(cur.name);
              return {
                id: `place:${pl.id}`,
                kind: 'place' as const,
                placeId: pl.id,
                name: pl.name,
                path: [...up, ...chain].join(' › '),
                icon: placeIcon(pl),
              };
            });
        })
        .slice(0, MAX_PLACES)
    : [];

  // "Add a thing" opens the create sheet in the location you're on (or your Personal one); without
  // a host that can show it, the location page, where Add here is.
  const here = /^\/loc\/([^/]+)/.exec(pathname)?.[1];
  const addTo = here ?? me.data?.personalLocationId ?? locs[0]?.id;
  const addToName = (() => {
    const l = locs.find((x) => x.id === addTo);
    return l ? nameOf(l) : '';
  })();
  const actions: Extract<Entry, { kind: 'action' }>[] = [
    ...(q
      ? [
          {
            id: 'act:search',
            kind: 'action' as const,
            label: t`Search for “${q}”`,
            icon: <SearchIcon />,
            hint: t`Every result, with filters`,
            run: () => navigate({ to: '/search', search: { q } }),
          },
        ]
      : []),
    ...(addTo
      ? [
          {
            id: 'act:add',
            kind: 'action' as const,
            label: t`Add a thing`,
            icon: <PlusIcon />,
            hint: t`In ${addToName}`,
            run: () =>
              onAddThing ? onAddThing(addTo) : navigate({ to: '/loc/$id', params: { id: addTo } }),
          },
        ]
      : []),
    {
      id: 'act:activity',
      kind: 'action' as const,
      label: t`Activity`,
      icon: <ActivityIcon />,
      run: () => navigate({ to: '/activity' }),
    },
    {
      id: 'act:trash',
      kind: 'action' as const,
      label: t`Trash`,
      icon: <TrashIcon />,
      run: () => navigate({ to: '/trash' }),
    },
    {
      id: 'act:settings',
      kind: 'action' as const,
      label: t`Settings`,
      icon: <GearIcon />,
      run: () => navigate({ to: '/settings' }),
    },
    {
      id: 'act:assistant',
      kind: 'action' as const,
      label: text.trim() ? t`Ask the assistant about “${text.trim()}”` : t`Ask the assistant`,
      icon: <AssistantIcon />,
      // After the palette's own history entry is gone (ui/close-on-back.tsx), so the phone's
      // sheet doesn't take the palette's Back for its own.
      run: () => void setTimeout(() => openAssistant(text), 50),
    },
  ];
  // Search and the assistant take the words themselves, so they stay whatever is typed.
  const shownActions = actions.filter(
    (a) => !q || a.id === 'act:search' || a.id === 'act:assistant' || nameMatches(a.label, q),
  );

  const thingEntries: Entry[] = things.map((thing) => ({
    id: `thing:${thing.id}`,
    kind: 'thing',
    thing,
  }));
  const all = [...thingEntries, ...locationEntries, ...placeEntries, ...shownActions];
  const byId = new Map(all.map((e) => [e.id, e]));
  const locName = (id: string) => {
    const l = locs.find((x) => x.id === id);
    return l ? nameOf(l) : '';
  };

  const onAction = (key: string) => {
    const e = byId.get(key);
    if (!e) return;
    if (e.kind === 'thing')
      go(() => navigate({ to: '/t/$id', params: { id: addressOf(e.thing) } }));
    else if (e.kind === 'place') go(() => navigate({ to: '/p/$id', params: { id: e.placeId } }));
    else if (e.kind === 'location')
      go(() => navigate({ to: '/loc/$id', params: { id: e.locationId } }));
    else go(e.run);
  };

  const count = thingEntries.length + placeEntries.length;
  const searching = !!q && search.isFetching && !search.data;

  // ----- the combobox: the active option, by id, kept while it's still listed -----
  const listId = useId();
  const optionId = (id: string) => `${listId}-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const enabled = all.map((e) => e.id);
  const [active, setActive] = useState<string | null>(null);
  const current = active && enabled.includes(active) ? active : (enabled[0] ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(current))}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!enabled.length) return;
      const at = current ? enabled.indexOf(current) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(enabled[(at + step + enabled.length) % enabled.length] ?? null);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // ⌘↵ asks the assistant with the words typed (frame 04 · 2).
      e.preventDefault();
      onAction('act:assistant');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) onAction(current);
    }
  };
  const option = (id: string, text: string, children: ReactNode, disabled = false) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keyboard (aria-activedescendant)
    <div
      key={id}
      id={optionId(id)}
      role="option"
      aria-selected={id === current}
      aria-disabled={disabled || undefined}
      aria-label={text}
      tabIndex={-1}
      onMouseMove={() => !disabled && id !== current && setActive(id)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => !disabled && onAction(id)}
      className={cn(
        'flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-2 text-[15px] text-ink outline-none',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        id === current && 'bg-sunken',
      )}
    >
      {children}
    </div>
  );
  const group = (key: string, title: ReactNode, children: ReactNode) => (
    // biome-ignore lint/a11y/useSemanticElements: an ARIA group of options inside a listbox
    <div key={key} role="group" aria-labelledby={`${listId}-${key}`}>
      <div id={`${listId}-${key}`} role="presentation" className="eyebrow px-2.5 pt-2.5 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
  const pathOf = (th: ThingRow) =>
    [locName(th.locationId), ...th.path.map((p) => placeName(p))].filter(Boolean).join(' › ');

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(o) => !o && onClose()}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-3 pt-[10dvh] md:px-4"
    >
      <Modal className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-[0_18px_50px_rgba(0,0,0,.28)] outline-none">
        <CloseOnBack />
        <Dialog aria-label={t`Search or jump to`} className="grid outline-none">
          <div className="flex items-center gap-2 border-b border-line px-4">
            <SearchIcon aria-hidden="true" className="size-5 shrink-0 text-ink-3" />
            <input
              role="combobox"
              aria-label={t`Search or jump to`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current ? optionId(current) : undefined}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              dir="auto"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t`Search things, or jump to a place`}
              className="min-h-14 w-full flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-ink-3"
            />
            {keyHints ? (
              <kbd
                dir="ltr"
                className="rounded border border-line px-1.5 font-mono text-[11px] text-ink-3"
              >
                esc
              </kbd>
            ) : null}
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t`Results`}
            className="max-h-[60dvh] overflow-y-auto p-1.5"
          >
            {thingEntries.length
              ? group(
                  'things',
                  <Trans>Things</Trans>,
                  thingEntries.map((e) =>
                    e.kind === 'thing'
                      ? option(
                          e.id,
                          [e.thing.name ?? t`Untitled draft`, pathOf(e.thing)].join(', '),
                          <>
                            <Glyph>
                              <TypeIcon icon={e.thing.type?.icon} />
                            </Glyph>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="font-semibold leading-snug [overflow-wrap:anywhere]">
                                {e.thing.name ? (
                                  <bdi>
                                    <Marked text={e.thing.name} forms={forms} />
                                  </bdi>
                                ) : (
                                  <Trans>Untitled draft</Trans>
                                )}
                              </span>
                              <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                                <bdi>{pathOf(e.thing)}</bdi>
                                {e.thing.matchedAlias ? (
                                  <>
                                    {sep()}
                                    <Trans>
                                      matched: <bdi>{e.thing.matchedAlias}</bdi>
                                    </Trans>
                                  </>
                                ) : null}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                              {e.thing.derivedState.map((st) => (
                                <StatusPill key={st} state={st} />
                              ))}
                              <IdChip code={e.thing.shortCode} />
                            </span>
                          </>,
                        )
                      : null,
                  ),
                )
              : null}
            {locationEntries.length || placeEntries.length
              ? group(
                  'places',
                  <Trans>Jump to</Trans>,
                  [...locationEntries, ...placeEntries].map((e) =>
                    e.kind === 'location'
                      ? option(
                          e.id,
                          e.name,
                          <>
                            <Glyph>
                              <KindIcon kind={e.locKind as never} />
                            </Glyph>
                            <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                              <bdi>
                                <Marked text={e.name} forms={forms} />
                              </bdi>
                            </span>
                          </>,
                        )
                      : e.kind === 'place'
                        ? option(
                            e.id,
                            `${e.name}, ${e.path}`,
                            <>
                              <Glyph>
                                <TypeIcon icon={e.icon} />
                              </Glyph>
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="font-medium [overflow-wrap:anywhere]">
                                  <bdi>
                                    <Marked text={e.name} forms={forms} />
                                  </bdi>
                                </span>
                                <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                                  <bdi>{e.path}</bdi>
                                </span>
                              </span>
                            </>,
                          )
                        : null,
                  ),
                )
              : null}
            {group('actions', <Trans>Actions</Trans>, [
              ...shownActions.map((e) =>
                option(
                  e.id,
                  e.label,
                  <>
                    <Glyph>{e.icon}</Glyph>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="font-medium [overflow-wrap:anywhere]">{e.label}</span>
                      {e.hint ? <span className="text-small text-ink-2">{e.hint}</span> : null}
                    </span>
                  </>,
                ),
              ),
            ])}
          </div>
          <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3 md:flex">
            {keyHints ? (
              <>
                <span>
                  <Kbd>↑↓</Kbd> <Trans>move</Trans>
                </span>
                <span>
                  <Kbd>↵</Kbd> <Trans>open</Trans>
                </span>
                <span>
                  <Kbd>esc</Kbd> <Trans>close</Trans>
                </span>
              </>
            ) : null}
            {q ? (
              <span className="ms-auto" aria-live="polite">
                {searching ? <Trans>Searching…</Trans> : <Trans>{count} found</Trans>}
              </span>
            ) : null}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sunken text-ink-2 [&_svg]:size-[18px]">
      {children}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd dir="ltr" className="rounded border border-line px-1 font-mono text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}
