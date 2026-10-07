/**
 * A Homebox import's choices before the check (screens §6 "dry-run choices", D146; plan T19 step
 * 6, Q3, Q16, Q25): the currency (the ZIP has none: the connection's, else the target's; another
 * enabled one relabels the amounts, it doesn't convert them), archived items, the "Insured"
 * field, Homebox's empty starter places and tags, each Homebox type mapped to a Kept type or
 * created, and each custom field added to its type or kept in the notes. Saved on the run with
 * If-Match (POST …/choices), then checked.
 *
 * The types are a list-standard list (search, a Match filter, pages), in the URL like the report.
 */
import type { HomeboxChoices } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { useCurrencies, useTypes } from '@/api/inventory/queries';
import type { HomeboxConnection, HomeboxMappingHints } from '@/api/portability/types';
import type { FilterDef } from '@/components/filters/types';
import { ListSurface } from '@/components/list-surface';
import { List, Notice, Row } from '@/components/page';
import { useTypeName } from '@/components/things/names';
import { Combobox } from '@/components/ui/combobox';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { useFormat } from '@/lib/format';
import { isNot, useListState } from '@/lib/url-state';
import { useMemoryPages } from './memory-list';

const CREATE = '__create__';
const fold = (s: string) => s.trim().toLocaleLowerCase();

type KeptType = { id: string; name: string };

/** The choices first offered: the connection's currency when it's enabled here, else the
 * target's; each type matched to a Kept type of the same name, else created; every field added
 * to its type (Q16); archived items left out; the Insured field; empty starter rows left out. */
export function initialChoices(
  hints: HomeboxMappingHints | undefined,
  keptTypes: readonly KeptType[],
  currency: string,
): HomeboxChoices {
  const byName = new Map(keptTypes.map((y) => [fold(y.name), y.id]));
  return {
    archived: 'skip',
    currency,
    quantityRounding: 'keep_note',
    fields: Object.fromEntries((hints?.fields ?? []).map((f) => [f.name, 'add_to_type' as const])),
    types: Object.fromEntries(
      (hints?.types ?? []).map((y) => {
        const match = byName.get(fold(y.name));
        return [y.id, match ? { typeId: match } : { create: y.name.trim().slice(0, 80) }];
      }),
    ),
    insured: 'field',
    seeded: 'skip_unused',
  };
}

/** The account's types as the combobox lists them (field groups aren't types you pick). */
export function useKeptTypes(accountId: string | undefined): KeptType[] | undefined {
  const types = useTypes(accountId ?? '');
  const typeName = useTypeName();
  return useMemo(
    () =>
      types.data?.types
        .filter((y) => !y.isFieldGroup)
        .map((y) => ({ id: y.id, name: typeName(y) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [types.data, typeName],
  );
}

export function HomeboxChoicesStep({
  hints,
  choices,
  onChange,
  keptTypes,
  locationCurrency,
  connection,
}: {
  hints: HomeboxMappingHints | undefined;
  choices: HomeboxChoices;
  onChange: (choices: HomeboxChoices) => void;
  keptTypes: readonly KeptType[];
  locationCurrency: string;
  connection: HomeboxConnection | null;
}) {
  const { t, i18n } = useLingui();
  const f = useFormat();
  const currencies = useCurrencies();
  const set = (patch: Partial<HomeboxChoices>) => onChange({ ...choices, ...patch });
  const enabled = (currencies.data?.currencies ?? []).filter((c) => c.enabled);
  const fromConnection = connection?.collections[0]?.currency;
  const connectionOff = !!fromConnection && !enabled.some((c) => c.code === fromConnection);
  const seeded = [...(hints?.seededUnused.places ?? []), ...(hints?.seededUnused.tags ?? [])];
  const insured = hints?.insuredItems ?? 0;
  const seededList = new Intl.ListFormat(i18n.locale || 'en', { type: 'conjunction' }).format(
    seeded,
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Combobox
          label={t`Prices are in`}
          items={enabled.map((c) => ({ id: c.code, label: c.code, description: c.name }))}
          selectedKey={choices.currency}
          onSelectionChange={(k) => {
            if (k) set({ currency: String(k) });
          }}
          description={
            fromConnection && !connectionOff && choices.currency === fromConnection
              ? t`From the connection to Homebox. Choosing another relabels the amounts; it doesn't convert them.`
              : t`Homebox's export has no currency. Choosing one relabels the amounts; it doesn't convert them.`
          }
        />
        {connectionOff ? (
          <Notice tone="warn">
            <Trans>
              Homebox's currency, <bdi dir="ltr">{fromConnection}</bdi>, isn't turned on in Kept. An
              instance admin can turn it on in Admin → Currencies.
            </Trans>
          </Notice>
        ) : null}
        {locationCurrency !== choices.currency ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>
              This location counts in <bdi dir="ltr">{locationCurrency}</bdi>; prices in another
              currency are kept as they are.
            </Trans>
          </p>
        ) : null}
      </div>

      <Segmented<HomeboxChoices['archived']>
        label={t`Archived items`}
        value={choices.archived}
        onChange={(archived) => set({ archived })}
        options={[
          { id: 'skip', label: t`Leave out` },
          { id: 'tag', label: t`Import, tagged "Archived in Homebox"` },
        ]}
      />

      {insured > 0 ? (
        <div className="grid gap-1">
          <Switch
            isSelected={choices.insured === 'field'}
            onChange={(on) => set({ insured: on ? 'field' : 'skip' })}
          >
            <Trans>Add an "Insured" yes/no field</Trans>
          </Switch>
          <p className="m-0 text-small text-ink-2">
            <Plural
              value={insured}
              one="# item is marked insured."
              other="# items are marked insured."
            />
          </p>
        </div>
      ) : null}

      {seeded.length > 0 ? (
        <div className="grid gap-1">
          <Switch
            isSelected={choices.seeded === 'skip_unused'}
            onChange={(on) => set({ seeded: on ? 'skip_unused' : 'all' })}
          >
            <Trans>Leave out Homebox's starter places and tags</Trans>
          </Switch>
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Only the empty ones: <bdi>{seededList}</bdi>.
            </Trans>
          </p>
        </div>
      ) : null}

      {hints && hints.types.length > 0 ? (
        <TypeMapping
          types={hints.types}
          choices={choices}
          onChange={onChange}
          keptTypes={keptTypes}
        />
      ) : null}

      {hints && hints.fields.length > 0 ? (
        <section className="grid gap-2" aria-labelledby="hb-fields">
          <h3 id="hb-fields" className="m-0 font-semibold text-[17px]">
            <Trans>Custom fields</Trans>
          </h3>
          <List aria-label={t`Custom fields`}>
            {hints.fields.map((field) => (
              <li key={field.name}>
                <Row
                  title={<bdi>{field.name}</bdi>}
                  subtitle={
                    <>
                      <FieldKind kind={field.kind} />
                      {f.sep}
                      <Plural value={field.items} one="on # item" other="on # items" />
                    </>
                  }
                >
                  <Segmented<'add_to_type' | 'notes'>
                    aria-label={t`What happens to ${field.name}`}
                    className="pt-1.5"
                    value={choices.fields[field.name] ?? 'add_to_type'}
                    onChange={(v) => set({ fields: { ...choices.fields, [field.name]: v } })}
                    options={[
                      { id: 'add_to_type', label: t`Add to the type` },
                      { id: 'notes', label: t`Keep in notes` },
                    ]}
                  />
                </Row>
              </li>
            ))}
          </List>
        </section>
      ) : null}

      {!hints ? (
        <Notice tone="info">
          <Trans>
            Homebox's types are matched to Kept's by name, and its custom fields are added to their
            types. The check shows what that does before anything is imported.
          </Trans>
        </Notice>
      ) : null}
    </div>
  );
}

function FieldKind({ kind }: { kind: string }) {
  switch (kind) {
    case 'number':
      return <Trans>number</Trans>;
    case 'boolean':
      return <Trans>yes or no</Trans>;
    case 'time':
      return <Trans>date</Trans>;
    default:
      return <Trans>text</Trans>;
  }
}

type TypeRow = HomeboxMappingHints['types'][number];

function TypeMapping({
  types,
  choices,
  onChange,
  keptTypes,
}: {
  types: HomeboxMappingHints['types'];
  choices: HomeboxChoices;
  onChange: (choices: HomeboxChoices) => void;
  keptTypes: readonly KeptType[];
}) {
  const { t } = useLingui();
  const [list] = useListState();
  const matched = (y: TypeRow) => {
    const c = choices.types[y.id];
    return !!c && 'typeId' in c;
  };
  const wanted = list.filters.typeMatch ?? [];
  const not = isNot(list, 'typeMatch');
  const q = fold(list.q);
  const rows = types.filter((y) => {
    const state = matched(y) ? 'matched' : 'create';
    if (wanted.length && wanted.includes(state) === not) return false;
    return !q || fold(y.name).includes(q);
  });
  const nMatched = types.filter(matched).length;
  const query = useMemoryPages(
    ['hb-types', q, wanted, not, JSON.stringify(choices.types)],
    rows,
    50,
  );
  const filters: FilterDef[] = [
    {
      key: 'typeMatch',
      label: t`Match`,
      kind: 'multi',
      hideZero: true,
      values: {
        from: 'static',
        options: [
          { value: 'matched', label: t`A Kept type`, count: nMatched },
          { value: 'create', label: t`Created`, count: types.length - nMatched },
        ],
      },
    },
  ];

  return (
    <section className="grid gap-2" aria-labelledby="hb-types">
      <h3 id="hb-types" className="m-0 font-semibold text-[17px]">
        <Trans>Types</Trans>
      </h3>
      <ListSurface<TypeRow>
        label={t`Homebox types`}
        search={{ label: t`Search Homebox types`, placeholder: t`Search` }}
        filters={filters}
        query={query}
        getKey={(y) => y.id}
        empty={null}
        renderRow={(y) => {
          const c = choices.types[y.id];
          const name = y.name;
          return (
            <div className="grid gap-2 px-3.5 py-2.5 sm:grid-cols-[1fr_minmax(0,18rem)] sm:items-center">
              <span className="grid gap-0.5">
                <bdi className="font-semibold [overflow-wrap:anywhere]">{name}</bdi>
                <span className="text-small text-ink-2">
                  <Plural value={y.items} one="# item" other="# items" />
                </span>
              </span>
              <Combobox
                aria-label={t`Kept type for ${name}`}
                items={[
                  { id: CREATE, label: t`Create "${name}"` },
                  ...keptTypes.map((k) => ({ id: k.id, label: k.name })),
                ]}
                selectedKey={c && 'typeId' in c ? c.typeId : CREATE}
                onSelectionChange={(k) => {
                  if (!k) return;
                  const next =
                    String(k) === CREATE
                      ? { create: name.trim().slice(0, 80) }
                      : { typeId: String(k) };
                  onChange({ ...choices, types: { ...choices.types, [y.id]: next } });
                }}
              />
            </div>
          );
        }}
      />
    </section>
  );
}
