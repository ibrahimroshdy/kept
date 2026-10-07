/**
 * The list's Display button (D211, screens §5 "The filter strip"): a list's view options (its
 * sort, the sort's direction, its grouping, and its layout where it has one) behind one compact
 * button at the end of the filter strip's row, never a row of their own.
 *
 *   [search box] [chips…] [+ Filter] [Views ▾] [⇅ Name · by type]
 *
 * The button names the current state ("Name", "Name · by type", "Changed · photos"); on a narrow
 * phone it keeps the icon and the sort's name, never cut short. It opens a React Aria menu (a
 * popover from 768 px, a bottom sheet on phones): a Sort list with a check mark, the direction
 * (A to Z / Z to A for words, Newest first / Oldest first for dates), then Group and Layout.
 * Arrow keys move, Enter or Space chooses, Escape closes and focus returns to the button.
 *
 * Everything is URL state (lib/url-state.ts): `sort`, `dir`, `group` and `view`. Choosing a
 * list's default writes nothing, so a saved view (D205) compares equal to the list it was saved
 * from.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import {
  Button as AriaButton,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  type Selection,
  Separator,
} from 'react-aria-components';
import { ArrowUpDownIcon, CheckIcon } from '@/components/icons';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { sep } from '@/lib/format';
import { useMediaQuery, WIDE } from '@/lib/media';
import type { ListState, SetListState, SortDir } from '@/lib/url-state';
import { cn } from '@/lib/utils';

/**
 * What a sort orders by: words (A to Z), dates that happened (newest first), or dates still to
 * come (`due`: soonest first; a schedule's or a loan's due date, step 4).
 */
export type SortKind = 'text' | 'date' | 'due';

export type DisplaySort = {
  value: string;
  label: string;
  /**
   * The button's words for it, when the menu's label is too long for the strip's one row on a
   * 375 px phone ("Vu le" for "Vu pour la dernière fois"). Default: the label.
   */
  short?: string;
  /** Words, dates or due dates: picks the direction's words and its default. Default `text`. */
  kind?: SortKind;
};
export type DisplayGroup = {
  value: string;
  label: string;
  /** The button's words for it ("by type"). Default: "by <label>". */
  short?: string;
};
export type DisplayLayout = {
  value: string;
  label: string;
  /** The button's words for it ("photos"). Default: the label. */
  short?: string;
};

export type DisplayOptions = {
  sorts?: DisplaySort[];
  groups?: DisplayGroup[];
  /** The grouping when the URL names none (default: the first). */
  defaultGroup?: string;
  layouts?: DisplayLayout[];
};

/** A sort's default direction: A to Z for words, newest first for dates, soonest first when due. */
export const defaultDir = (kind: SortKind = 'text'): SortDir => (kind === 'date' ? 'desc' : 'asc');

/** The Display button's state read from the URL: each choice or its default. */
export function displayState(list: ListState, o: DisplayOptions) {
  const sort = o.sorts?.find((s) => s.value === list.sort) ?? o.sorts?.[0];
  const kind = sort?.kind ?? 'text';
  const dir: SortDir = list.dir || defaultDir(kind);
  const groupDefault = o.defaultGroup ?? o.groups?.[0]?.value;
  const group =
    o.groups?.find((g) => g.value === (list.group ?? groupDefault)) ??
    o.groups?.find((g) => g.value === groupDefault);
  const layout = o.layouts?.find((l) => l.value === list.layout) ?? o.layouts?.[0];
  return { sort, kind, dir, group, groupDefault, layout };
}

const itemClass =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-ink outline-none data-focused:bg-sunken data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info';
const headerClass = 'eyebrow px-3 pt-2 pb-1';
const dirClass =
  'flex min-h-10 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-center text-[14px] leading-tight text-ink-2 outline-none data-focused:text-ink data-selected:bg-surface data-selected:font-medium data-selected:text-ink data-selected:shadow-[0_1px_2px_rgba(0,0,0,.08)] data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info';

const only = (keys: Selection): string | undefined =>
  keys === 'all' ? undefined : (([...keys][0] as string | undefined) ?? undefined);

function Check({ on }: { on: boolean }) {
  return (
    <CheckIcon
      aria-hidden="true"
      className={cn('ms-auto size-4 shrink-0 text-ink', on ? 'visible' : 'invisible')}
    />
  );
}

export function DisplayButton({
  options,
  list,
  setList,
}: {
  options: DisplayOptions;
  list: ListState;
  setList: SetListState;
}) {
  const { t } = useLingui();
  const wide = useMediaQuery(WIDE);
  const [open, setOpen] = useState(false);
  const { sorts, groups, layouts } = options;
  const state = displayState(list, options);
  const { sort, kind, dir, group, groupDefault, layout } = state;
  const grouped = !!group && group.value !== 'none';
  const groupName = group?.label ?? '';
  const groupShort = grouped ? (group.short ?? t`by ${groupName}`) : undefined;
  const layoutShort =
    layout && layouts && layout.value !== layouts[0]?.value
      ? (layout.short ?? layout.label)
      : undefined;
  const dirWords =
    kind === 'date'
      ? { asc: t`Oldest first`, desc: t`Newest first` }
      : kind === 'due'
        ? { asc: t`Soonest first`, desc: t`Latest first` }
        : { asc: t`A to Z`, desc: t`Z to A` };

  // The accessible name says it all: "Display options: sorted by Name, A to Z, by type".
  const sortName = sort?.label ?? '';
  const dirName = dirWords[dir];
  let name = sort ? t`Display options: sorted by ${sortName}, ${dirName}` : t`Display options`;
  for (const extra of [groupShort, layoutShort]) if (extra) name = t`${name}, ${extra}`;

  const suffix = [groupShort, layoutShort].filter(Boolean).join(sep());
  const trigger = (
    <AriaButton
      aria-label={name}
      aria-haspopup={wide ? 'menu' : 'dialog'}
      onPress={wide ? undefined : () => setOpen(true)}
      className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-2 outline-none data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info [&_svg]:size-3.5"
    >
      <ArrowUpDownIcon aria-hidden="true" />
      {sort ? <span>{sort.short ?? sort.label}</span> : null}
      {suffix ? (
        // On a narrow phone the button keeps its icon and the sort's name (never cut short).
        <span className={cn(sort && 'hidden min-[420px]:inline')}>
          {sort ? sep() : null}
          {suffix}
        </span>
      ) : null}
      {!sort && !suffix ? <Trans>Display</Trans> : null}
    </AriaButton>
  );

  const pick = (patch: Partial<ListState>) => setList(patch);
  const menu = (autoFocus: boolean) => (
    <Menu
      aria-label={t`Display options`}
      shouldCloseOnSelect={false}
      {...(autoFocus ? { autoFocus: 'first' as const } : {})}
      className="grid gap-px p-1 outline-none"
    >
      {sorts?.length ? (
        <MenuSection
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={sort ? [`sort:${sort.value}`] : []}
          onSelectionChange={(keys) => {
            const next = sorts.find((s) => `sort:${s.value}` === only(keys));
            if (!next) return;
            const sameKind = (next.kind ?? 'text') === kind;
            pick({
              sort: next.value === sorts[0]?.value ? '' : next.value,
              ...(sameKind ? {} : { dir: '' }),
            });
          }}
        >
          <Header className={headerClass}>
            <Trans>Sort</Trans>
          </Header>
          {sorts.map((s) => (
            <MenuItem
              key={s.value}
              id={`sort:${s.value}`}
              textValue={s.label}
              className={itemClass}
            >
              {({ isSelected }) => (
                <>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.label}</span>
                  <Check on={isSelected} />
                </>
              )}
            </MenuItem>
          ))}
        </MenuSection>
      ) : null}
      {sort ? (
        <MenuSection
          aria-label={t`Order`}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[`dir:${dir}`]}
          onSelectionChange={(keys) => {
            const next = only(keys)?.slice(4) as SortDir | undefined;
            if (next) pick({ dir: next === defaultDir(kind) ? '' : next });
          }}
          className="mx-2 my-1 grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1"
        >
          {(kind === 'date' ? (['desc', 'asc'] as const) : (['asc', 'desc'] as const)).map((d) => (
            <MenuItem key={d} id={`dir:${d}`} textValue={dirWords[d]} className={dirClass}>
              {dirWords[d]}
            </MenuItem>
          ))}
        </MenuSection>
      ) : null}
      {groups?.length ? (
        <>
          {sorts?.length ? <Separator className="my-1 h-px bg-line" /> : null}
          <MenuSection
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={group ? [`group:${group.value}`] : []}
            onSelectionChange={(keys) => {
              const next = only(keys)?.slice(6);
              if (next !== undefined) pick({ group: next === groupDefault ? '' : next });
            }}
          >
            <Header className={headerClass}>
              <Trans>Group</Trans>
            </Header>
            {groups.map((g) => (
              <MenuItem
                key={g.value}
                id={`group:${g.value}`}
                textValue={g.label}
                className={itemClass}
              >
                {({ isSelected }) => (
                  <>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{g.label}</span>
                    <Check on={isSelected} />
                  </>
                )}
              </MenuItem>
            ))}
          </MenuSection>
        </>
      ) : null}
      {layouts?.length ? (
        <>
          <Separator className="my-1 h-px bg-line" />
          <MenuSection
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={layout ? [`layout:${layout.value}`] : []}
            onSelectionChange={(keys) => {
              const next = only(keys)?.slice(7);
              if (next !== undefined) pick({ layout: next === layouts[0]?.value ? '' : next });
            }}
          >
            <Header className={headerClass}>
              <Trans>Layout</Trans>
            </Header>
            {layouts.map((l) => (
              <MenuItem
                key={l.value}
                id={`layout:${l.value}`}
                textValue={l.label}
                className={itemClass}
              >
                {({ isSelected }) => (
                  <>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.label}</span>
                    <Check on={isSelected} />
                  </>
                )}
              </MenuItem>
            ))}
          </MenuSection>
        </>
      ) : null}
    </Menu>
  );

  if (wide)
    return (
      <MenuTrigger isOpen={open} onOpenChange={setOpen}>
        {trigger}
        <Popover
          placement="bottom end"
          offset={6}
          className="z-50 w-[min(18rem,calc(100vw-2rem))] rounded-[10px] border border-line bg-surface text-ink shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          {menu(false)}
        </Popover>
      </MenuTrigger>
    );
  return (
    <>
      {trigger}
      <Sheet isOpen={open} onOpenChange={setOpen} title={t`Display`}>
        {({ close }) => (
          <div className="grid gap-3">
            {menu(true)}
            <DialogFooter>
              <Button onPress={close}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        )}
      </Sheet>
    </>
  );
}
