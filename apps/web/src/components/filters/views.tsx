/**
 * Saved views on every list (D205; D42, D183 for search): the current filters kept under a name,
 * for you or shared with a location (sharing needs `saved-views.share` there, as before).
 *
 * - Pinned views are tabs above the strip, after "All". Pins and the default are yours alone,
 *   whoever made the view.
 * - The default view opens when you come to the list with nothing in its URL.
 * - Opening a view puts its state in the URL with `saved=<id>`; change a filter and the strip
 *   offers "Save changes" (your own views) and "Save as new".
 * - Views ▾ lists the list's views: open, pin, make default, delete (your own; a location's
 *   admins may delete its shared ones; the server has the last word).
 */
import { can, type ListSurface, MAX_PINNED_VIEWS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { useSavedViews } from '@/api/inventory/queries';
import type { SavedView, SavedViewPrefs } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import {
  BookmarkIcon,
  ChevronDownIcon,
  PeopleIcon,
  PinIcon,
  StarIcon,
  TrashIcon,
} from '@/components/icons';
import { useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { ChoiceCards } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import type { ListState, SetListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import {
  clearedState,
  hasQuery,
  isModified,
  queryOf,
  savedViewApi,
  stateOf,
  useInvalidateViews,
} from './views-api';

export type ViewsState = {
  surface: ListSurface;
  views: SavedView[];
  prefs: SavedViewPrefs;
  /** The view the URL was opened from, if it still exists. */
  active: SavedView | undefined;
  modified: boolean;
};

const NO_PREFS: SavedViewPrefs = { defaultViewId: null, pinned: [] };

/** The list's views and prefs, and the default view applied on arrival. Null without a surface. */
export function useSavedViewsState(
  surface: ListSurface | undefined,
  list: ListState,
  setList: SetListState,
): ViewsState | null {
  const query = useSavedViews(surface ?? 'search', !!surface);
  const views = surface ? (query.data?.views ?? []).filter((v) => v.surface === surface) : [];
  const prefs = query.data?.prefs ?? NO_PREFS;
  // The default opens once, on arrival, and only if the URL says nothing yet.
  const arrival = useRef(
    list.q === '' && Object.keys(list.filters).length === 0 && list.savedView === undefined,
  );
  const defaultView = views.find((v) => v.id === prefs.defaultViewId);
  useEffect(() => {
    if (!surface || !query.data || !arrival.current) return;
    arrival.current = false;
    if (defaultView) setList(stateOf(defaultView, list), { replace: true });
  }, [surface, query.data, defaultView, list, setList]);
  if (!surface) return null;
  const active = list.savedView ? views.find((v) => v.id === list.savedView) : undefined;
  return {
    surface,
    views,
    prefs,
    active,
    modified: active ? isModified(active, list) : false,
  };
}

const tabClass =
  'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info aria-pressed:bg-ink aria-pressed:text-paper [&_svg]:size-3.5';

/** "All" and the pinned views, above the strip. Nothing when none is pinned. */
export function ViewTabs({
  state,
  list,
  setList,
}: {
  state: ViewsState;
  list: ListState;
  setList: SetListState;
}) {
  const { t } = useLingui();
  const pinned = state.prefs.pinned
    .map((id) => state.views.find((v) => v.id === id))
    .filter((v): v is SavedView => !!v);
  if (pinned.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form fieldset
    <div role="group" aria-label={t`Pinned views`} className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        aria-pressed={!list.savedView}
        onClick={() => setList(clearedState(list))}
        className={tabClass}
      >
        <Trans>All</Trans>
      </button>
      {pinned.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={list.savedView === v.id}
          onClick={() => setList(stateOf(v, list))}
          className={cn(tabClass, 'text-start')}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <bdi>{v.name}</bdi>
          </span>
          {list.savedView === v.id && state.modified ? (
            <span className="sr-only">{t`(changed)`}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** "Changed: Save changes · Save as new", under the strip while an opened view is modified. */
export function ViewChanged({
  state,
  list,
  setList,
}: {
  state: ViewsState;
  list: ListState;
  setList: SetListState;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const invalidate = useInvalidateViews();
  const [saving, setSaving] = useState(false);
  const view = state.active;
  const update = useMutation({
    mutationFn: (v: SavedView) =>
      savedViewApi.update(v.id, { query: queryOf(list, v.surface) }, v.rowVersion),
    onSuccess: async (v) => {
      await invalidate();
      const name = v.name;
      toast({ title: t`Saved ${name}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  if (!view || !state.modified) return null;
  const name = view.name;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-sunken px-3 py-1.5 text-small text-ink-2"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <Trans>
          You changed <bdi className="font-semibold text-ink">{name}</bdi>.
        </Trans>
      </span>
      {view.mine ? (
        <Button
          size="small"
          variant="secondary"
          isPending={update.isPending}
          onPress={() => update.mutate(view)}
        >
          <Trans>Save changes</Trans>
        </Button>
      ) : null}
      <Button size="small" variant="secondary" onPress={() => setSaving(true)}>
        <Trans>Save as new</Trans>
      </Button>
      <Button size="small" variant="ghost" onPress={() => setList(stateOf(view, list))}>
        <Trans>Undo changes</Trans>
      </Button>
      <SaveViewSheet
        isOpen={saving}
        onClose={() => setSaving(false)}
        state={state}
        list={list}
        setList={setList}
      />
    </div>
  );
}

/** "Views ▾": the list's saved views, and Save view. */
export function ViewsButton({
  state,
  list,
  setList,
}: {
  state: ViewsState;
  list: ListState;
  setList: SetListState;
}) {
  const { t } = useLingui();
  const wide = useMediaQuery(WIDE);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const canSave = hasQuery(queryOf(list, state.surface)) && !(state.active && !state.modified);
  const body = (close: () => void) => (
    <ViewsMenu
      state={state}
      list={list}
      setList={setList}
      canSave={canSave}
      onSave={() => {
        close();
        setSaving(true);
      }}
      onOpened={close}
    />
  );
  const trigger = (
    <AriaButton
      aria-haspopup="dialog"
      onPress={wide ? undefined : () => setOpen(true)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-2 outline-none data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-3.5"
    >
      <BookmarkIcon aria-hidden="true" />
      <Trans>Views</Trans>
      <ChevronDownIcon aria-hidden="true" />
    </AriaButton>
  );
  return (
    <>
      {wide ? (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          {trigger}
          <Popover
            placement="bottom end"
            offset={6}
            className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-[10px] border border-line bg-surface p-3 text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
          >
            <Dialog aria-label={t`Saved views`} className="outline-none">
              {({ close }) => body(close)}
            </Dialog>
          </Popover>
        </DialogTrigger>
      ) : (
        <>
          {trigger}
          <Sheet isOpen={open} onOpenChange={setOpen} title={t`Saved views`} wide>
            {({ close }) => body(close)}
          </Sheet>
        </>
      )}
      <SaveViewSheet
        isOpen={saving}
        onClose={() => setSaving(false)}
        state={state}
        list={list}
        setList={setList}
      />
    </>
  );
}

function ViewsMenu({
  state,
  list,
  setList,
  canSave,
  onSave,
  onOpened,
}: {
  state: ViewsState;
  list: ListState;
  setList: SetListState;
  canSave: boolean;
  onSave: () => void;
  onOpened: () => void;
}) {
  const { t } = useLingui();
  const locations = useLocations();
  const nameOf = useLocationName();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateViews();
  const prefs = useMutation({
    mutationFn: (next: SavedViewPrefs) => savedViewApi.prefs(state.surface, next),
    onSuccess: () => invalidate(),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const remove = useMutation({
    mutationFn: (v: SavedView) => savedViewApi.remove(v.id),
    onSuccess: async (_r, v) => {
      await invalidate();
      if (list.savedView === v.id) setList({ savedView: '' }, { replace: true });
      const name = v.name;
      toast({ title: t`Deleted ${name}`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const roleIn = (id: string) => locations.data?.find((l) => l.id === id)?.role;
  const mayDelete = (v: SavedView) =>
    v.mine ||
    (v.sharedLocationId !== null &&
      (roleIn(v.sharedLocationId) === 'owner' || roleIn(v.sharedLocationId) === 'admin'));
  const where = (v: SavedView) => {
    if (!v.sharedLocationId) return t`Only you`;
    const l = locations.data?.find((x) => x.id === v.sharedLocationId);
    const name = l ? nameOf(l) : '';
    const by = v.createdBy.displayName;
    return v.mine ? t`Shared with ${name}` : t`Shared with ${name} · by ${by}`;
  };
  const { pinned, defaultViewId } = state.prefs;
  const setPrefs = (next: Partial<SavedViewPrefs>) =>
    prefs.mutate({ pinned, defaultViewId, ...next });

  return (
    <div className="grid gap-3">
      {state.views.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>No saved views yet. Filter the list, then save it to come back to it.</Trans>
        </p>
      ) : (
        <ul
          aria-label={t`Saved views`}
          className="m-0 grid max-h-[50dvh] list-none gap-px overflow-y-auto p-0"
        >
          {state.views.map((v) => {
            const isPinned = pinned.includes(v.id);
            const isDefault = defaultViewId === v.id;
            const name = v.name;
            return (
              <li key={v.id} className="flex items-center gap-1 rounded-lg hover:bg-sunken">
                <button
                  type="button"
                  aria-current={list.savedView === v.id ? 'true' : undefined}
                  onClick={() => {
                    setList(stateOf(v, list));
                    onOpened();
                  }}
                  className="grid min-h-11 min-w-0 flex-1 gap-0.5 rounded-lg px-2.5 py-1.5 text-start outline-none focus-visible:outline-2 focus-visible:outline-info"
                >
                  <span className="flex items-center gap-1.5 font-semibold text-[14.5px] leading-snug [overflow-wrap:anywhere]">
                    {v.sharedLocationId ? (
                      <PeopleIcon aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                    ) : null}
                    <bdi>{v.name}</bdi>
                    {isDefault ? (
                      <span className="rounded-full bg-sunken px-1.5 text-[11.5px] font-medium text-ink-2">
                        <Trans>Default</Trans>
                      </span>
                    ) : null}
                  </span>
                  <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
                    {where(v)}
                    {v.moneyHidden ? (
                      <>
                        {sep()}
                        {t`Price hidden here`}
                      </>
                    ) : null}
                  </span>
                </button>
                <AriaButton
                  aria-label={isPinned ? t`Unpin ${name}` : t`Pin ${name}`}
                  aria-pressed={isPinned}
                  isDisabled={!isPinned && pinned.length >= MAX_PINNED_VIEWS}
                  onPress={() =>
                    setPrefs({
                      pinned: isPinned ? pinned.filter((id) => id !== v.id) : [...pinned, v.id],
                    })
                  }
                  className={cn(
                    'grid size-9 shrink-0 cursor-pointer place-items-center rounded-md outline-none data-hovered:bg-surface data-focus-visible:outline-2 data-focus-visible:outline-info data-disabled:opacity-40 [&_svg]:size-4',
                    isPinned ? 'text-ink' : 'text-ink-3',
                  )}
                >
                  <PinIcon />
                </AriaButton>
                <AriaButton
                  aria-label={
                    isDefault ? t`Stop opening ${name} first` : t`Open ${name} first here`
                  }
                  aria-pressed={isDefault}
                  onPress={() => setPrefs({ defaultViewId: isDefault ? null : v.id })}
                  className={cn(
                    'grid size-9 shrink-0 cursor-pointer place-items-center rounded-md outline-none data-hovered:bg-surface data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-4',
                    isDefault ? 'text-amber-ink' : 'text-ink-3',
                  )}
                >
                  <StarIcon fill={isDefault ? 'currentColor' : 'none'} />
                </AriaButton>
                {mayDelete(v) ? (
                  <AriaButton
                    aria-label={t`Delete ${name}`}
                    onPress={async () => {
                      if (
                        await confirm({
                          title: t`Delete the saved view ${name}?`,
                          body: v.sharedLocationId
                            ? t`It goes for everyone it's shared with. What it shows stays.`
                            : t`What it shows stays.`,
                          confirmLabel: t`Delete`,
                          destructive: true,
                        })
                      )
                        remove.mutate(v);
                    }}
                    className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-md text-ink-3 outline-none data-hovered:bg-surface data-hovered:text-danger data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-4"
                  >
                    <TrashIcon />
                  </AriaButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="secondary" isDisabled={!canSave} onPress={onSave}>
        <BookmarkIcon aria-hidden="true" className="size-4" />
        <Trans>Save view</Trans>
      </Button>
      {!canSave ? (
        <p className="m-0 text-small text-ink-3">
          <Trans>Search or filter the list first; a view keeps what you chose.</Trans>
        </p>
      ) : null}
    </div>
  );
}

/** Save the current filters as a new view: a name, who sees it, and whether to pin it. */
function SaveViewSheet({
  isOpen,
  onClose,
  state,
  list,
  setList,
}: {
  isOpen: boolean;
  onClose: () => void;
  state: ViewsState;
  list: ListState;
  setList: SetListState;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Save view`}>
      {({ close }) => <SaveViewForm state={state} list={list} setList={setList} onDone={close} />}
    </Sheet>
  );
}

function SaveViewForm({
  state,
  list,
  setList,
  onDone,
}: {
  state: ViewsState;
  list: ListState;
  setList: SetListState;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const locations = useLocations();
  const nameOf = useLocationName();
  const errorText = useErrorText();
  const invalidate = useInvalidateViews();
  const query = queryOf(list, state.surface);
  const [name, setName] = useState(state.active ? '' : (query.q ?? ''));
  const [share, setShare] = useState<string>('me');
  const [pin, setPin] = useState(state.prefs.pinned.length < MAX_PINNED_VIEWS);
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string>();
  const shareable = (locations.data ?? []).filter(
    (l) => l.kind !== 'personal' && can(l.role, 'saved-views.share'),
  );
  const save = useMutation({
    mutationFn: async () => {
      const view = await savedViewApi.create({
        name: name.trim(),
        surface: state.surface,
        query,
        sharedLocationId: share === 'me' ? null : share,
      });
      if (pin || makeDefault) {
        await savedViewApi.prefs(state.surface, {
          pinned: pin ? [...state.prefs.pinned, view.id] : state.prefs.pinned,
          defaultViewId: makeDefault ? view.id : state.prefs.defaultViewId,
        });
      }
      return view;
    },
    onSuccess: async (v) => {
      await invalidate();
      setList({ savedView: v.id }, { replace: true });
      const saved = v.name;
      toast({ title: t`Saved ${saved}`, tone: 'ok' });
      onDone();
    },
    onError: (e) =>
      setError(
        isApiError(e) && e.status === 409 && e.details.reason === 'limit'
          ? t`You have 100 saved views, the most there can be. Delete one to save this.`
          : errorText(e),
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t`Give it a name, like Cables or This week.`);
      return;
    }
    setError(undefined);
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate aria-label={t`Save view`}>
      <TextField
        label={t`Name`}
        value={name}
        onChange={setName}
        isRequired
        autoFocus
        maxLength={80}
        errorMessage={error}
        isInvalid={!!error}
      />
      {shareable.length ? (
        <ChoiceCards
          label={t`Who sees it`}
          value={share}
          onChange={setShare}
          options={[
            { id: 'me', title: t`Only me`, body: t`It stays in your saved views.` },
            ...shareable.map((l) => {
              const where = nameOf(l);
              return {
                id: l.id,
                title: t`Everyone in ${where}`,
                body: t`Members of ${where} see it too. Each still sees only what they may.`,
              };
            }),
          ]}
        />
      ) : null}
      <Switch isSelected={pin} onChange={setPin}>
        <Trans>Pin it as a tab above the list</Trans>
      </Switch>
      <Switch isSelected={makeDefault} onChange={setMakeDefault}>
        <Trans>Open this list with it</Trans>
      </Switch>
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
