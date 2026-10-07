/**
 * The filter strip (D205, screens §5 "The filter strip"): one filtering component for every list.
 *
 *   [saved view tabs…]
 *   [search box] [active filter chips…] [+ Filter] [Views ▾] [⇅ Display]
 *
 * Only filters in use show, as chips ("Person: Alfred, Bruce ×"); "Clear all" appears with two or
 * more. "+ Filter" opens the list's fields (a popover on desktop); on phones the same panel is a
 * bottom sheet behind "Filters (n)". Chips wrap and are never cut off. The list's sort, grouping
 * and layout are the Display button at the end of the row (D211, ./display.tsx), never a row of
 * their own.
 *
 * Keyboard: `/` focuses the search box, `F` opens "+ Filter", Backspace in an empty search box
 * removes the last chip, and the arrow keys move between chips (mirrored in RTL). The shortcuts
 * belong to the first strip on the page and never fire while typing or in a dialog.
 *
 * Everything is URL state (lib/url-state.ts), so a filtered list can be linked and Back undoes
 * the last change: the first change while a panel is open adds a history entry, the rest of that
 * panel's changes replace it.
 */
import type { ListSurface } from '@kept/shared';
import { parseDateRange } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button as AriaButton, Dialog, Popover } from 'react-aria-components';
import { FilterIcon, PlusIcon, SearchIcon, XIcon } from '@/components/icons';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { useFormat } from '@/lib/format';
import { useMediaQuery, WIDE } from '@/lib/media';
import { type ListState, useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import {
  EditorHeading,
  FieldEditor,
  FieldMenu,
  type FilterPatch,
  isActive,
  patchFor,
  removal,
  usePresetLabels,
} from './panel';
import { type FilterDef, keysOf } from './types';
import { useValueLabels } from './values';
import { useSavedViewsState, ViewChanged, ViewsButton, ViewTabs } from './views';

export type StripSearch = {
  label: string;
  placeholder: string;
  /** Enter was pressed (the search page remembers the search). */
  onCommit?: (q: string) => void;
  /** Focus the box when the page opens with nothing typed (the Search tab). */
  autoFocus?: boolean;
  /** The search page's larger box. */
  large?: boolean;
  /**
   * A control at the end of the search box's row, which the box makes room for: a list's Select
   * (UI audit L5, where it sat alone on a row above the box).
   */
  end?: ReactNode;
  /**
   * The box takes its own row at every width, the buttons on the row under it: for a strip in a
   * narrow column on a wide screen (the inbox's 384 px list, where Views wrapped; UI audit L6).
   */
  fullRow?: boolean;
};

export type FilterStripProps = {
  filters: FilterDef[];
  /** The list's saved views (D205); none when omitted. */
  surface?: ListSurface;
  /** The search box; `false` for a list too short to need one. */
  search: StripSearch | false;
  /** The Display button (D211, ./display.tsx), last in the strip's row. */
  display?: ReactNode;
  /** Anything under the strip's row. A list's view options go in `display`, never here. */
  children?: ReactNode;
};

const SEARCH_DEBOUNCE_MS = 250;

const chipBase =
  'inline-flex min-h-9 max-w-full items-center gap-1.5 border border-ink bg-ink text-[13px] font-medium text-paper outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info [&_svg]:size-3.5';
const plainChip =
  'inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-3.5';

// The first strip on a page owns the keyboard shortcuts.
const owners: symbol[] = [];

type Open = { field: string | null; fromMenu: boolean; anchor: RefObject<HTMLElement | null> };

export function FilterStrip({ filters, surface, search, display, children }: FilterStripProps) {
  const { t } = useLingui();
  const f = useFormat();
  const [list, setList] = useListState();
  const wide = useMediaQuery(WIDE);
  const [open, setOpen] = useState<Open | null>(null);
  const pushed = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const chipRefs = useRef(new Map<string, HTMLElement>());
  const active = filters.filter((d) => isActive(d, list));
  const views = useSavedViewsState(surface, list, setList);

  const commit = (patch: FilterPatch) => {
    setList(patch, { replace: pushed.current });
    pushed.current = true;
  };
  const openPanel = (field: string | null, anchor: RefObject<HTMLElement | null>) => {
    pushed.current = false;
    setOpen({ field, fromMenu: field === null, anchor });
  };
  const close = () => setOpen(null);
  const remove = (def: FilterDef) => setList(removal(def, list));
  const clearAll = () =>
    setList({
      filters: Object.fromEntries(active.flatMap((d) => keysOf(d)).map((key) => [key, []])),
      not: [],
    });

  // Keyboard shortcuts: `/` and `F`, for the first strip on the page.
  const openRef = useRef(openPanel);
  openRef.current = openPanel;
  useEffect(() => {
    const me = Symbol('strip');
    owners.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (owners[0] !== me || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (el?.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'))
        return;
      if (e.key === '/' && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      } else if ((e.key === 'f' || e.key === 'F') && filters.length) {
        e.preventDefault();
        openRef.current(null, addRef);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      owners.splice(owners.indexOf(me), 1);
    };
  }, [filters.length]);

  // Arrow keys move between the chips' buttons, in reading order.
  const onChipsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')
      return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-chip-stop]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const forward = (e.key === 'ArrowRight') !== rtl;
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (forward ? 1 : -1)));
    e.preventDefault();
    items[next]?.focus();
  };

  const openDef = open?.field ? filters.find((d) => d.key === open.field) : undefined;
  const panel = open ? (
    <div className="grid gap-3">
      {openDef ? (
        <>
          <EditorHeading
            def={openDef}
            onBack={open.fromMenu ? () => setOpen({ ...open, field: null }) : null}
          />
          <FieldEditor def={openDef} list={list} commit={commit} onDone={close} />
        </>
      ) : (
        <FieldMenu
          defs={filters}
          list={list}
          autoFocus
          onPick={(def) => {
            if (def.kind === 'boolean') {
              commit(
                isActive(def, list) ? removal(def, list) : patchFor(def, list, [def.on ?? '1']),
              );
              close();
            } else setOpen({ ...open, field: def.key });
          }}
        />
      )}
    </div>
  ) : null;

  const count = active.length;
  return (
    <div className="grid min-w-0 gap-2.5">
      {views ? <ViewTabs state={views} list={list} setList={setList} /> : null}
      {/* biome-ignore lint/a11y/useSemanticElements: a group of controls, not a form fieldset */}
      <div
        role="group"
        aria-label={t`Filters`}
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        {search !== false ? (
          <SearchBox
            ref={searchRef}
            {...search}
            value={list.q}
            onChange={(q) => setList({ q }, { replace: true })}
            onBackspaceEmpty={() => {
              const last = active.at(-1);
              if (last) remove(last);
            }}
          />
        ) : null}
        {filters.length && !wide ? (
          <AriaButton
            ref={addRef}
            onPress={() => openPanel(null, addRef)}
            aria-haspopup="dialog"
            className={plainChip}
          >
            <FilterIcon aria-hidden="true" />
            <Trans>Filters</Trans>
            {count ? (
              <>
                <span
                  aria-hidden="true"
                  className="grid min-w-5 place-items-center rounded-full bg-ink px-1 text-[11.5px] leading-5 text-paper tabular-nums"
                >
                  {f.num(count)}
                </span>
                <span className="sr-only"> ({f.num(count)})</span>
              </>
            ) : null}
          </AriaButton>
        ) : null}
        {views && !wide ? <ViewsButton state={views} list={list} setList={setList} /> : null}
        {!wide ? display : null}
        {count ? (
          <div
            role="toolbar"
            aria-label={t`Filters in use`}
            onKeyDown={onChipsKey}
            className="flex min-w-0 flex-wrap items-center gap-1.5 md:flex-[2_1_0%]"
          >
            {active.map((def) => (
              <Chip
                key={def.key}
                def={def}
                list={list}
                register={(el) => {
                  if (el) chipRefs.current.set(def.key, el);
                  else chipRefs.current.delete(def.key);
                }}
                onOpen={() =>
                  openPanel(def.key, {
                    get current() {
                      return chipRefs.current.get(def.key) ?? null;
                    },
                  })
                }
                onRemove={() => remove(def)}
              />
            ))}
            {count > 1 ? (
              <button
                type="button"
                data-chip-stop=""
                onClick={clearAll}
                className="min-h-9 rounded-md px-2 text-[13px] font-medium text-ink-2 underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
              >
                <Trans>Clear all</Trans>
              </button>
            ) : null}
          </div>
        ) : null}
        {filters.length && wide ? (
          <AriaButton
            ref={addRef}
            onPress={() => openPanel(null, addRef)}
            aria-haspopup="dialog"
            aria-keyshortcuts="F"
            className={plainChip}
          >
            <PlusIcon aria-hidden="true" />
            <Trans>Filter</Trans>
          </AriaButton>
        ) : null}
        {views && wide ? <ViewsButton state={views} list={list} setList={setList} /> : null}
        {wide ? display : null}
      </div>
      {views ? <ViewChanged state={views} list={list} setList={setList} /> : null}
      {children}

      {open && wide ? (
        <Popover
          isOpen
          onOpenChange={(o) => !o && close()}
          triggerRef={open.anchor}
          placement="bottom start"
          offset={6}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-[10px] border border-line bg-surface p-3 text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          <Dialog aria-label={openDef?.label ?? t`Filter by`} className="outline-none">
            {panel}
          </Dialog>
        </Popover>
      ) : null}
      {open && !wide ? (
        <Sheet isOpen onOpenChange={(o) => !o && close()} title={t`Filters`} wide>
          <div className="grid gap-4">
            {panel}
            <DialogFooter>
              {count > 1 ? (
                <Button variant="secondary" onPress={clearAll}>
                  <Trans>Clear all</Trans>
                </Button>
              ) : null}
              <Button onPress={close}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

/** One filter in use: its name and values (open to change them) and × to remove it. */
function Chip({
  def,
  list,
  register,
  onOpen,
  onRemove,
}: {
  def: FilterDef;
  list: ListState;
  register: (el: HTMLElement | null) => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const label = def.label;
  const summary = <ChipValue def={def} list={list} />;
  const not = list.not.includes(def.key);
  return (
    <span className="inline-flex max-w-full items-stretch">
      {def.kind === 'boolean' ? (
        <span className={cn(chipBase, 'rounded-s-full ps-3 pe-2')}>{label}</span>
      ) : (
        <button
          ref={register}
          type="button"
          data-chip-stop=""
          aria-haspopup="dialog"
          onClick={onOpen}
          className={cn(chipBase, 'rounded-s-full py-1 ps-3 pe-2 text-start hover:bg-ink/90')}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {not ? (
              <Trans>
                {label}: not {summary}
              </Trans>
            ) : (
              <Trans>
                {label}: {summary}
              </Trans>
            )}
          </span>
        </button>
      )}
      <button
        type="button"
        data-chip-stop=""
        aria-label={t`Remove the ${label} filter`}
        onClick={onRemove}
        className={cn(chipBase, 'rounded-e-full border-s-paper/30 px-2 hover:bg-ink/90')}
      >
        <XIcon aria-hidden="true" />
      </button>
    </span>
  );
}

/** A chip's values: "Alfred, Bruce", "Last 7 days", "1 Sep – 20 Sep", "150–400 EGP". */
function ChipValue({ def, list }: { def: FilterDef; list: ListState }) {
  const f = useFormat();
  const { t } = useLingui();
  const presets = usePresetLabels();
  const chosen = list.filters[def.key] ?? [];
  const named = useValueLabels(def, def.kind === 'multi' || def.kind === 'single' ? chosen : []);
  if (def.kind === 'date-range') {
    const v = chosen[0] ?? '';
    if (v in presets) return <>{presets[v as keyof typeof presets]}</>;
    const r = parseDateRange(v);
    if (!r) return <>{v}</>;
    const from = r.from ? f.day(r.from) : '';
    const to = r.to ? f.day(r.to) : '';
    return <>{from && to ? `${from} – ${to}` : from ? t`From ${from}` : t`Until ${to}`}</>;
  }
  if (def.kind === 'number-range') {
    const keys = def.range ?? { min: `${def.key}Min`, max: `${def.key}Max` };
    const min = list.filters[keys.min]?.[0];
    const max = list.filters[keys.max]?.[0];
    const currency = keys.currency ? list.filters[keys.currency]?.[0] : undefined;
    const n = (v: string) => f.num(Number(v));
    const range =
      min && max ? `${n(min)}–${n(max)}` : min ? t`From ${n(min)}` : max ? t`Up to ${n(max)}` : '';
    return (
      <>
        {range}
        {currency ? (
          <>
            {' '}
            <bdi dir="ltr">{currency}</bdi>
          </>
        ) : null}
      </>
    );
  }
  if (named.length === 0) return <Plural value={chosen.length} one="# chosen" other="# chosen" />;
  const unnamed = chosen.length - named.length;
  return (
    <>
      {named.map((o, i) => (
        <span key={o.value}>
          {i > 0 ? t`, ` : null}
          <bdi>{o.label}</bdi>
        </span>
      ))}
      {unnamed > 0 ? (
        <>
          {' '}
          <Plural value={unnamed} one="and # more" other="and # more" />
        </>
      ) : null}
    </>
  );
}

/**
 * The list's search box: typing reaches the URL after a pause (one replaced history entry),
 * Enter commits at once, Escape clears, Backspace in an empty box removes the last filter chip.
 * Back/forward refill it.
 */
function SearchBox({
  ref,
  value,
  label,
  placeholder,
  onChange,
  onCommit,
  onBackspaceEmpty,
  autoFocus,
  large,
  end,
  fullRow,
}: StripSearch & {
  ref: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (q: string) => void;
  onBackspaceEmpty: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [text, setText] = useState(value);
  const pushed = useRef(value);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    if (value !== pushed.current) {
      pushed.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = text;
      changeRef.current(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const box = (
    <form
      className={cn(
        'relative min-w-0',
        end ? 'flex-1' : fullRow ? 'basis-full' : 'basis-full md:min-w-64 md:flex-[1_1_16rem]',
      )}
      onSubmit={(e) => {
        e.preventDefault();
        pushed.current = text;
        changeRef.current(text);
        onCommit?.(text);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <SearchIcon
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ink-3',
          large ? 'size-5' : 'size-[18px]',
        )}
      />
      <input
        ref={ref}
        id={id}
        type="search"
        dir="auto"
        // biome-ignore lint/a11y/noAutofocus: the Search tab exists to type into this box
        autoFocus={!!autoFocus && !value}
        enterKeyHint="search"
        aria-keyshortcuts="/"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text) {
            e.preventDefault();
            setText('');
          } else if (e.key === 'Backspace' && text === '') {
            onBackspaceEmpty();
          }
        }}
        className={cn(
          'w-full rounded-lg border border-line bg-surface text-ink outline-none placeholder:text-ink-3 focus-visible:border-info focus-visible:outline-2 focus-visible:outline-info [&::-webkit-search-cancel-button]:hidden',
          large ? 'min-h-12 ps-11 text-[16px]' : 'min-h-11 ps-10 text-[15px]',
          // The end padding is the clear button's room, kept only while it shows: empty, the
          // placeholder gets it ("Name, brand, serial or ID" was clipped at 375 in Arabic).
          text ? (large ? 'pe-11' : 'pe-10') : 'pe-3',
        )}
      />
      {text ? (
        <button
          type="button"
          aria-label={t`Clear search`}
          onClick={() => setText('')}
          className="absolute end-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md text-ink-3 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
        >
          <XIcon width={16} height={16} />
        </button>
      ) : null}
    </form>
  );
  if (!end) return box;
  return (
    <div
      className={cn(
        'flex min-w-0 basis-full items-center gap-2',
        !fullRow && 'md:min-w-64 md:flex-[1_1_16rem]',
      )}
    >
      {box}
      <div className="shrink-0">{end}</div>
    </div>
  );
}
