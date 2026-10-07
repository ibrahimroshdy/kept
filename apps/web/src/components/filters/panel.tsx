/**
 * What "+ Filter" opens (D205): the list's fields, fuzzy-searchable, and one field's editor. The
 * same panel sits in a popover on desktop and in the "Filters (n)" bottom sheet on phones.
 *
 * - multi: search over its values (Arabic-aware; the server's for people, brands and tags),
 *   checkboxes, "Only this", and "is any of / is none of".
 * - single: pick one.
 * - date-range: Today · Last 7 days · Last 30 days · This year · Custom range, on Kept's own
 *   calendar (never the OS picker); only the calendar where the list looks ahead (`presets: false`).
 * - number-range: a lowest and a highest value (and their currency); amounts accept Arabic
 *   digits and `٫` (D172).
 * - boolean: on from the menu, off from its chip.
 *
 * Changes reach the URL as they are made (`commit`), so the list behind updates live.
 */

import { type CalendarDate, parseDate } from '@internationalized/date';
import {
  AmountError,
  DATE_PRESETS,
  type DatePreset,
  parseAmount,
  parseDateRange,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useId, useMemo, useState } from 'react';
import {
  Button as AriaButton,
  CalendarCell,
  CalendarGrid,
  Checkbox,
  GridList,
  GridListItem,
  Heading,
  I18nProvider,
  ListBox,
  ListBoxItem,
  RangeCalendar,
} from 'react-aria-components';
import { CheckIcon, ChevronEndIcon, ChevronStartIcon, SearchIcon } from '@/components/icons';
import { CurrencyPicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import type { ListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { fuzzyFilter } from './fuzzy';
import { type FilterDef, type FilterOption, keysOf } from './types';
import { useFilterOptions, useValueLabels } from './values';

/** A change to the list's filters: the keys to set (empty to clear) and the new `not`. */
export type FilterPatch = { filters: Record<string, string[]>; not: string[] };
export type Commit = (patch: FilterPatch) => void;

/** Whether `def` narrows the list now. */
export function isActive(def: FilterDef, list: ListState): boolean {
  return keysOf(def).some((key) => (list.filters[key]?.length ?? 0) > 0);
}

/** The patch that sets `def` to `values` ("is none of" when `not`), emptying what it clears. */
export function patchFor(
  def: FilterDef,
  list: ListState,
  values: string[],
  not = false,
): FilterPatch {
  const cleared = def.clears ?? [];
  return {
    filters: { [def.key]: values, ...Object.fromEntries(cleared.map((key) => [key, []])) },
    not: [
      ...list.not.filter((key) => key !== def.key && !cleared.includes(key)),
      ...(not && values.length ? [def.key] : []),
    ],
  };
}

/** The patch that removes `def` altogether. */
export function removal(def: FilterDef, list: ListState): FilterPatch {
  const keys = keysOf(def);
  return {
    filters: Object.fromEntries(keys.map((key) => [key, []])),
    not: list.not.filter((key) => !keys.includes(key)),
  };
}

const rowClass =
  'group flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[15px] leading-snug text-ink outline-none data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-info data-focused:bg-sunken data-hovered:bg-sunken';
const listClass =
  'grid max-h-[min(55dvh,22rem)] content-start gap-px overflow-y-auto rounded-[10px] border border-line p-1 outline-none';

/** The text box at the top of a menu or a field's values. */
export function FindField({
  label,
  value,
  onChange,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-ink-3"
      />
      <input
        id={id}
        type="search"
        dir="auto"
        // biome-ignore lint/a11y/noAutofocus: the popover opened to type into this box
        autoFocus={autoFocus}
        value={value}
        placeholder={label}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-line bg-surface ps-10 pe-3 text-[15px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-info focus-visible:outline-2 focus-visible:outline-info [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/** The fields of "+ Filter": fuzzy-searchable, the ones in use marked. */
export function FieldMenu({
  defs,
  list,
  onPick,
  autoFocus,
}: {
  defs: FilterDef[];
  list: ListState;
  onPick: (def: FilterDef) => void;
  autoFocus: boolean;
}) {
  const { t } = useLingui();
  const [q, setQ] = useState('');
  const offered = defs.filter(
    (d) =>
      isActive(d, list) ||
      !(d.kind === 'boolean' && d.hideZero && d.values?.from === 'static'
        ? d.values.options.every((o) => o.count === 0)
        : false),
  );
  const shown = fuzzyFilter(offered, q, (d) => d.label);
  return (
    <div className="grid gap-2">
      {offered.length > 5 ? (
        <FindField label={t`Find a filter`} value={q} onChange={setQ} autoFocus={autoFocus} />
      ) : null}
      <ListBox
        aria-label={t`Filter by`}
        items={shown}
        autoFocus={autoFocus && offered.length <= 5 ? 'first' : false}
        onAction={(key) => {
          const def = shown.find((d) => d.key === key);
          if (def) onPick(def);
        }}
        renderEmptyState={() => (
          <div className="px-3 py-2.5 text-small text-ink-3">
            <Trans>No matches</Trans>
          </div>
        )}
        className={listClass}
      >
        {(d: FilterDef) => {
          const on = isActive(d, list);
          return (
            <ListBoxItem id={d.key} textValue={d.label} className={rowClass}>
              <span aria-hidden="true" className="text-ink-3 [&_svg]:size-[18px]">
                {d.icon}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{d.label}</span>
              {on ? (
                <span className="grid size-5 shrink-0 place-items-center text-ok">
                  <CheckIcon aria-hidden="true" className="size-4" />
                  <span className="sr-only">{t`(in use)`}</span>
                </span>
              ) : null}
            </ListBoxItem>
          );
        }}
      </ListBox>
    </div>
  );
}

/** One field's editor, by its kind. `onDone` closes the panel (after a single choice). */
export function FieldEditor({
  def,
  list,
  commit,
  onDone,
}: {
  def: FilterDef;
  list: ListState;
  commit: Commit;
  onDone: () => void;
}) {
  switch (def.kind) {
    case 'multi':
      return <ValuesEditor def={def} list={list} commit={commit} onDone={onDone} />;
    case 'single':
      return <ValuesEditor def={def} list={list} commit={commit} onDone={onDone} single />;
    case 'date-range':
      return <DateEditor def={def} list={list} commit={commit} onDone={onDone} />;
    case 'number-range':
      return <RangeEditor def={def} list={list} commit={commit} onDone={onDone} />;
    case 'boolean':
      return <BooleanEditor def={def} list={list} commit={commit} onDone={onDone} />;
  }
}

type EditorProps = {
  def: FilterDef;
  list: ListState;
  commit: Commit;
  onDone: () => void;
};

function ValuesEditor({
  def,
  list,
  commit,
  onDone,
  single = false,
}: EditorProps & { single?: boolean }) {
  const { t } = useLingui();
  const f = useFormat();
  const chosen = list.filters[def.key] ?? [];
  const [mode, setMode] = useState<'any' | 'none'>(list.not.includes(def.key) ? 'none' : 'any');
  const [q, setQ] = useState('');
  const { options, isPending, isError } = useFilterOptions(def, q);
  // What was chosen when the panel opened leads the list; what's chosen now stays in place, so
  // rows don't jump under the pointer.
  const [initial] = useState(chosen);
  const named = useValueLabels(def, initial);
  const negatable = !single && def.negatable !== false;

  const items = useMemo(() => {
    const visible = def.hideZero
      ? options.filter((o) => o.count !== 0 || chosen.includes(o.value))
      : options;
    if (q.trim()) return visible;
    // Nothing typed: what was chosen first (even if the server's first page lacks it), then the rest.
    const first: FilterOption[] = [
      ...named,
      ...visible.filter(
        (o) => initial.includes(o.value) && !named.some((n) => n.value === o.value),
      ),
    ];
    return [...first, ...visible.filter((o) => !initial.includes(o.value))];
  }, [options, named, initial, chosen, q, def.hideZero]);

  const set = (values: string[], m = mode) => commit(patchFor(def, list, values, m === 'none'));
  const searchable = def.values?.from === 'server' || options.length > 8 || q !== '';
  const find = def.findLabel ?? t`Find a value`;

  return (
    <div className="grid gap-3">
      {negatable ? (
        <Segmented
          aria-label={t`Match`}
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (chosen.length) set(chosen, m);
          }}
          options={[
            { id: 'any', label: <Trans>is any of</Trans> },
            { id: 'none', label: <Trans>is none of</Trans> },
          ]}
        />
      ) : null}
      {searchable ? <FindField label={find} value={q} onChange={setQ} autoFocus /> : null}
      <GridList
        aria-label={def.label}
        items={items}
        selectionMode={single ? 'single' : 'multiple'}
        selectionBehavior="toggle"
        // Escape closes the popover; it never clears what was chosen.
        escapeKeyBehavior="none"
        selectedKeys={new Set(chosen)}
        autoFocus={searchable ? false : 'first'}
        onSelectionChange={(keys) => {
          const next =
            keys === 'all'
              ? [...new Set([...chosen, ...items.map((o) => o.value)])]
              : [...keys].map(String);
          if (single) {
            const picked = next.filter((v) => !chosen.includes(v));
            set(picked.length ? [picked[0] as string] : []);
            onDone();
          } else set(next);
        }}
        renderEmptyState={() => (
          <div className="px-3 py-2.5 text-small text-ink-3">
            {isPending ? (
              <Trans>Loading…</Trans>
            ) : isError ? (
              <Trans>Couldn't load the choices. Try again in a moment.</Trans>
            ) : (
              <Trans>No matches</Trans>
            )}
          </div>
        )}
        className={listClass}
      >
        {(o: FilterOption) => (
          <GridListItem id={o.value} textValue={o.label} className={rowClass}>
            {({ isSelected }) => (
              <>
                {single ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded-full border-2 border-ink-3',
                      isSelected && 'border-ink',
                    )}
                  >
                    {isSelected ? <span className="size-2.5 rounded-full bg-ink" /> : null}
                  </span>
                ) : (
                  <Checkbox
                    slot="selection"
                    className="grid size-5 shrink-0 place-items-center rounded-[5px] border-2 border-ink-3 outline-none data-selected:border-ink data-selected:bg-ink data-selected:text-paper"
                  >
                    {isSelected ? <CheckIcon aria-hidden="true" className="size-3.5" /> : null}
                  </Checkbox>
                )}
                {o.icon ? (
                  <span aria-hidden="true" className="text-ink-3 [&_svg]:size-[18px]">
                    {o.icon}
                  </span>
                ) : null}
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="[overflow-wrap:anywhere]">
                    <bdi>{o.label}</bdi>
                  </span>
                  {o.description ? (
                    <span className="text-small text-ink-3 [overflow-wrap:anywhere]">
                      <bdi>{o.description}</bdi>
                    </span>
                  ) : null}
                </span>
                {o.count !== undefined ? (
                  <span className="text-small tabular-nums text-ink-3">{f.num(o.count)}</span>
                ) : null}
                {single ? null : (
                  <AriaButton
                    onPress={() => set([o.value])}
                    className="min-h-8 shrink-0 cursor-pointer rounded-md px-2 text-[12.5px] font-medium text-ink-2 underline underline-offset-2 outline-none data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info md:opacity-0 md:group-data-focus-visible:opacity-100 md:group-data-focused:opacity-100 md:group-data-hovered:opacity-100 md:data-focus-visible:opacity-100"
                  >
                    <Trans>Only this</Trans>
                    <span className="sr-only">
                      : <bdi>{o.label}</bdi>
                    </span>
                  </AriaButton>
                )}
              </>
            )}
          </GridListItem>
        )}
      </GridList>
      {chosen.length ? (
        <Button variant="ghost" size="small" className="justify-self-start" onPress={() => set([])}>
          <Trans>Clear</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function BooleanEditor({ def, list, commit, onDone }: EditorProps) {
  const on = isActive(def, list);
  return (
    <Button
      variant="secondary"
      onPress={() => {
        commit(on ? removal(def, list) : patchFor(def, list, [def.on ?? '1']));
        onDone();
      }}
    >
      {on ? <Trans>Show everything</Trans> : <Trans>Only {def.label}</Trans>}
    </Button>
  );
}

/** The date presets' names. */
export function usePresetLabels(): Record<DatePreset, string> {
  const { t } = useLingui();
  return {
    today: t`Today`,
    week: t`Last 7 days`,
    month: t`Last 30 days`,
    year: t`This year`,
  };
}

const toDate = (v: string | null): CalendarDate | null => {
  if (!v) return null;
  try {
    return parseDate(v);
  } catch {
    return null;
  }
};

function DateEditor({ def, list, commit, onDone }: EditorProps) {
  const { t } = useLingui();
  const labels = usePresetLabels();
  const prefs = usePrefs();
  const value = list.filters[def.key]?.[0];
  const range = value ? parseDateRange(value) : null;
  // Without presets (a list of what's ahead) the calendar is all there is.
  const onlyCustom = def.presets === false;
  const [custom, setCustom] = useState(!!range || onlyCustom);
  const CUSTOM = '__custom__';
  const items = [
    ...DATE_PRESETS.map((p) => ({ id: p as string, label: labels[p] })),
    { id: CUSTOM, label: t`Custom range` },
  ];
  const selected = custom ? CUSTOM : (value ?? '');
  const start = toDate(range?.from ?? null);
  const end = toDate(range?.to ?? null);
  return (
    <div className="grid gap-3">
      {onlyCustom ? null : (
        <ListBox
          aria-label={def.label}
          items={items}
          selectionMode="single"
          escapeKeyBehavior="none"
          selectedKeys={selected ? [selected] : []}
          autoFocus="first"
          onAction={(key) => {
            if (key === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            commit(patchFor(def, list, [String(key)]));
            onDone();
          }}
          className={listClass}
        >
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label} className={rowClass}>
              {({ isSelected }) => (
                <>
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {isSelected ? <CheckIcon aria-hidden="true" className="size-4 text-ok" /> : null}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      )}
      {custom ? (
        // The reader's digits (D204: Eastern Arabic unless they chose Western).
        <I18nProvider locale={formatLocale(prefs.locale, prefs.digits)}>
          <RangeCalendar
            aria-label={onlyCustom ? def.label : t`Custom range`}
            autoFocus={onlyCustom}
            {...(start && end ? { defaultValue: { start, end } } : {})}
            onChange={(r) => {
              commit(patchFor(def, list, [`${r.start.toString()}..${r.end.toString()}`]));
              onDone();
            }}
            className="grid justify-items-center gap-2"
          >
            <header className="flex w-full items-center justify-between gap-2">
              <AriaButton
                slot="previous"
                aria-label={t`Previous month`}
                className="grid size-10 cursor-pointer place-items-center rounded-lg outline-none data-hovered:bg-sunken data-focus-visible:outline-2 data-focus-visible:outline-info"
              >
                <ChevronStartIcon />
              </AriaButton>
              <Heading className="m-0 font-semibold text-[15px]" />
              <AriaButton
                slot="next"
                aria-label={t`Next month`}
                className="grid size-10 cursor-pointer place-items-center rounded-lg outline-none data-hovered:bg-sunken data-focus-visible:outline-2 data-focus-visible:outline-info"
              >
                <ChevronEndIcon />
              </AriaButton>
            </header>
            <CalendarGrid className="border-separate border-spacing-y-0.5">
              {(date) => (
                <CalendarCell
                  date={date}
                  className="grid size-10 cursor-pointer place-items-center text-[14px] tabular-nums outline-none data-hovered:bg-sunken data-selected:bg-sunken data-selection-start:rounded-s-lg data-selection-start:bg-ink data-selection-start:text-paper data-selection-end:rounded-e-lg data-selection-end:bg-ink data-selection-end:text-paper data-outside-month:invisible data-focus-visible:outline-2 data-focus-visible:outline-info"
                />
              )}
            </CalendarGrid>
          </RangeCalendar>
        </I18nProvider>
      ) : null}
    </div>
  );
}

function RangeEditor({ def, list, commit, onDone }: EditorProps) {
  const { t } = useLingui();
  const keys = def.range ?? { min: `${def.key}Min`, max: `${def.key}Max` };
  const [lo, setLo] = useState(list.filters[keys.min]?.[0] ?? '');
  const [hi, setHi] = useState(list.filters[keys.max]?.[0] ?? '');
  const [cur, setCur] = useState<string | null>(
    keys.currency ? (list.filters[keys.currency]?.[0] ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const read = (v: string): string | null | undefined => {
    if (!v.trim()) return null;
    try {
      return parseAmount(v);
    } catch (e) {
      if (e instanceof AmountError) return undefined;
      throw e;
    }
  };
  const apply = () => {
    const a = read(lo);
    const b = read(hi);
    if (a === undefined || b === undefined)
      return setError(t`Enter an amount, like 1250 or 1250.50.`);
    if (a !== null && b !== null && Number(a) > Number(b))
      return setError(t`The lowest is above the highest.`);
    commit({
      filters: {
        [keys.min]: a ? [a] : [],
        [keys.max]: b ? [b] : [],
        ...(keys.currency ? { [keys.currency]: cur && (a || b) ? [cur] : [] } : {}),
      },
      not: list.not,
    });
    onDone();
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {keys.currency ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>The price paid for one, as recorded on its purchase.</Trans>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t`From`}
          value={lo}
          onChange={setLo}
          autoFocus
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        />
        <TextField
          label={t`Up to`}
          value={hi}
          onChange={setHi}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        />
      </div>
      {keys.currency ? <CurrencyPicker label={t`Currency`} value={cur} onChange={setCur} /> : null}
      {error ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="justify-self-end">
        <Trans>Apply</Trans>
      </Button>
    </form>
  );
}

/** A field's heading in the panel, with Back to the fields when it was reached from them. */
export function EditorHeading({
  def,
  onBack,
}: {
  def: FilterDef;
  onBack: (() => void) | null;
}): ReactNode {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-1.5">
      {onBack ? (
        <AriaButton
          aria-label={t`All filters`}
          onPress={onBack}
          className="grid size-9 cursor-pointer place-items-center rounded-md text-ink-2 outline-none data-hovered:bg-sunken data-hovered:text-ink data-focus-visible:outline-2 data-focus-visible:outline-info"
        >
          <ChevronStartIcon aria-hidden="true" className="size-[18px]" />
        </AriaButton>
      ) : null}
      <span className="font-semibold text-[15px]">{def.label}</span>
    </div>
  );
}
