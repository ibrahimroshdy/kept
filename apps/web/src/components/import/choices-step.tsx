/**
 * Choices (plan T30 step 5; T18's `choices`): how place paths are split and whether missing places
 * are made, the date format (guessed from the file), the prices' currency when there's no currency
 * column, where a row without a place goes, and whether the type column is matched to types by
 * name. A choice that no mapped column needs isn't shown.
 */
import { DATE_FORMATS, type DateFormat, type MappableField } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ImportChoices } from '@/api/capture/types';
import { useCurrencies, usePlaces } from '@/api/inventory/queries';
import { Combobox } from '@/components/ui/combobox';
import { Description } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const UNPLACED = 'unplaced';
const LOCATION_CURRENCY = 'location';

/** An example date in a format: 31 December 2026, written that way. */
export function exampleDate(format: DateFormat): string {
  return format.replace('YYYY', '2026').replace('MM', '12').replace('DD', '31');
}

export function ChoicesStep({
  locationId,
  locationCurrency,
  mapping,
  choices,
  onChange,
  dateCandidates,
}: {
  locationId: string;
  locationCurrency: string;
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
  onChange: (next: ImportChoices) => void;
  /** Formats every sampled date reads in (suggest.ts), for the hint under the choice. */
  dateCandidates: DateFormat[];
}) {
  const { t } = useLingui();
  const places = usePlaces(locationId);
  const currencies = useCurrencies();
  const mapped = new Set(Object.values(mapping));
  const has = (f: MappableField) => mapped.has(f);
  const hasCustom = [...mapped].some((f) => f.startsWith('custom.'));
  const set = (patch: Partial<ImportChoices>) => onChange({ ...choices, ...patch });

  const tree = (places.data?.places ?? []).filter((p) => !p.isUnplaced);
  const byId = new Map(tree.map((p) => [p.id, p]));
  const pathOf = (id: string | null): string => {
    const out: string[] = [];
    let cur = id ? byId.get(id) : undefined;
    while (cur) {
      out.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out.join(' › ');
  };
  const targets = [
    { id: UNPLACED, label: t`Unplaced` },
    ...tree.map((p) => ({
      id: p.id,
      label: p.name,
      ...(p.parentId ? { description: pathOf(p.parentId) } : {}),
    })),
  ];
  const currencyItems = [
    { id: LOCATION_CURRENCY, label: t`The location's currency (${locationCurrency})` },
    ...(currencies.data?.currencies ?? [])
      .filter((c) => c.enabled)
      .map((c) => ({ id: c.code, label: c.code, description: c.name })),
  ];
  const dateItems = DATE_FORMATS.map((f) => ({ id: f, label: f, example: exampleDate(f) }));

  return (
    <div className="grid gap-5">
      {has('place_path') ? (
        <fieldset className="m-0 grid gap-3 border-0 p-0">
          <legend className="mb-2 p-0 font-semibold text-[17px]">
            <Trans>Places</Trans>
          </legend>
          <Segmented
            label={t`The place column separates places with`}
            value={choices.placeSeparator}
            onChange={(v) => set({ placeSeparator: v })}
            options={[
              { id: '>', label: <span dir="ltr">Garage &gt; Shelf</span> },
              { id: '/', label: <span dir="ltr">Garage / Shelf</span> },
              { id: '\\', label: <span dir="ltr">Garage \ Shelf</span> },
            ]}
          />
          <Switch isSelected={choices.createPlaces} onChange={(v) => set({ createPlaces: v })}>
            <Trans>Make the places the file names that don't exist yet</Trans>
          </Switch>
        </fieldset>
      ) : null}

      <Combobox
        label={t`Rows without a place go to`}
        items={targets}
        selectedKey={'placeId' in choices.defaultTarget ? choices.defaultTarget.placeId : UNPLACED}
        onSelectionChange={(k) => {
          if (!k) return;
          set({
            defaultTarget: String(k) === UNPLACED ? { unplaced: true } : { placeId: String(k) },
          });
        }}
        description={
          has('place_path')
            ? t`Also where a row goes when its place isn't made.`
            : t`No column is a place, so every row goes here.`
        }
      />

      {has('purchased_on') || hasCustom ? (
        <div className="grid gap-1">
          <Select<(typeof dateItems)[number]>
            label={t`Dates are written as`}
            items={dateItems}
            value={choices.dateFormat}
            onChange={(k) => {
              if (k) set({ dateFormat: String(k) as DateFormat });
            }}
            renderValue={([item]) =>
              item ? (
                <span dir="ltr">
                  {item.label} · {item.example}
                </span>
              ) : null
            }
          >
            {(item) => (
              <SelectItem id={item.id} textValue={item.label}>
                <span dir="ltr">
                  {item.label} · {item.example}
                </span>
              </SelectItem>
            )}
          </Select>
          {dateCandidates.length === 1 ? (
            <Description>
              <Trans>Worked out from the dates in the file.</Trans>
            </Description>
          ) : dateCandidates.length > 1 ? (
            <Description>
              <Trans>
                The dates in the file read more than one way (is 03/04 the 3rd of April or the 4th
                of March?). Check this one.
              </Trans>
            </Description>
          ) : null}
        </div>
      ) : null}

      {has('price') ? (
        <Combobox
          label={t`Prices are in`}
          items={currencyItems}
          selectedKey={choices.currency ?? LOCATION_CURRENCY}
          onSelectionChange={(k) => {
            if (!k) return;
            const { currency: _drop, ...rest } = choices;
            onChange(String(k) === LOCATION_CURRENCY ? rest : { ...rest, currency: String(k) });
          }}
          description={
            has('currency')
              ? t`For rows whose currency column is empty.`
              : t`No column is a currency, so every price is in this one.`
          }
        />
      ) : null}

      {has('type') ? (
        <Switch isSelected={choices.typeByName} onChange={(v) => set({ typeByName: v })}>
          <span className="grid gap-0.5">
            <span>
              <Trans>Match the type column to your types by name</Trans>
            </span>
            <span className="text-small text-ink-2">
              <Trans>In any of Kept's languages. Off, the type is kept in the notes.</Trans>
            </span>
          </span>
        </Switch>
      ) : null}
    </div>
  );
}
