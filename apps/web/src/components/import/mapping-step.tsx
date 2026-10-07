/**
 * Mapping (plan T30 step 4): each column of the file, with a few of its values, and the field it
 * goes to, guessed from its header in any of the five languages (suggest.ts). One column must be
 * the name; a field that holds one value takes one column (notes, tags, other names and codes
 * take several). "A type's field" maps a column to a custom field by its key.
 */
import type { MappableField } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Notice } from '@/components/page';
import { Combobox } from '@/components/ui/combobox';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { FIELD_ORDER, useFieldLabel } from './labels';
import type { ParsedCsv } from './parse';
import { CUSTOM_KEY, MULTI_FIELDS } from './suggest';

const CUSTOM = 'custom';
const SAMPLES = 3;

export type MappingProblems = {
  /** No column is the name. */
  noName: boolean;
  /** Per column: the earlier column already mapped to its (single-valued) field. */
  twice: Record<string, string>;
  /** Columns mapped to a custom field whose key isn't a valid key. */
  badKey: string[];
};

export function mappingProblems(
  columns: readonly string[],
  mapping: Readonly<Record<string, MappableField>>,
): MappingProblems {
  const first = new Map<string, string>();
  const twice: Record<string, string> = {};
  const badKey: string[] = [];
  for (const column of columns) {
    const field = mapping[column] ?? 'ignore';
    if (field.startsWith('custom.') && !CUSTOM_KEY.test(field.slice('custom.'.length))) {
      badKey.push(column);
    }
    const earlier = first.get(field);
    if (earlier !== undefined && !MULTI_FIELDS.has(field)) twice[column] = earlier;
    else if (earlier === undefined) first.set(field, column);
  }
  return { noName: !first.has('name'), twice, badKey };
}

export const hasProblems = (p: MappingProblems) =>
  p.noName || Object.keys(p.twice).length > 0 || p.badKey.length > 0;

export function MappingStep({
  parsed,
  mapping,
  onChange,
  showProblems,
}: {
  parsed: ParsedCsv;
  mapping: Record<string, MappableField>;
  onChange: (mapping: Record<string, MappableField>) => void;
  /** Show what's wrong (after Next was pressed). */
  showProblems: boolean;
}) {
  const { t } = useLingui();
  const fieldLabel = useFieldLabel();
  const f = useFormat();
  const problems = mappingProblems(parsed.columns, mapping);
  const options = [
    ...FIELD_ORDER.map((f) => ({ id: f as string, label: fieldLabel(f) })),
    { id: CUSTOM, label: t`A type's field…` },
  ];
  const rows = parsed.rows.length;
  const quoteRow = f.num(parsed.unclosedQuoteRow ?? 0);

  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Plural
          value={rows}
          one="# row. Say what each column is; the guesses come from the headers."
          other="# rows. Say what each column is; the guesses come from the headers."
        />
      </p>
      {parsed.unclosedQuoteRow !== null ? (
        <Notice tone="warn">
          <Trans>
            A quote in row {quoteRow} is never closed, so the rows after it may be read wrongly.
            Check the file if the values look odd.
          </Trans>
        </Notice>
      ) : null}
      {showProblems && problems.noName ? (
        <Notice tone="danger">
          <Trans>Choose which column is the name: every thing needs one.</Trans>
        </Notice>
      ) : null}
      <ul
        aria-label={t`Columns`}
        className="m-0 grid list-none gap-0 overflow-hidden rounded-[10px] border border-line bg-surface p-0"
      >
        {parsed.columns.map((column, index) => {
          const field = mapping[column] ?? 'ignore';
          const isCustom = field.startsWith('custom.');
          const samples = parsed.rows
            .map((r) => (r[index] ?? '').trim())
            .filter((v) => v !== '')
            .slice(0, SAMPLES);
          const earlier = problems.twice[column];
          const fieldName = fieldLabel(field);
          return (
            <li
              key={column}
              className="grid gap-3 border-line p-3.5 not-first:border-t md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start"
            >
              <div className="grid min-w-0 gap-1">
                <span className="font-semibold [overflow-wrap:anywhere]">
                  <bdi>{column}</bdi>
                </span>
                {samples.length > 0 ? (
                  <ul
                    aria-label={t`Values in ${column}`}
                    className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                  >
                    {samples.map((s, i) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: samples repeat and never move
                        key={i}
                        className="rounded-md bg-sunken px-2 py-0.5 text-small text-ink-2 [overflow-wrap:anywhere]"
                      >
                        <bdi>{s}</bdi>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-small text-ink-3">
                    <Trans>Empty in every row</Trans>
                  </span>
                )}
              </div>
              <div className="grid gap-2">
                <Combobox
                  label={t`${column} goes to`}
                  items={options}
                  selectedKey={isCustom ? CUSTOM : field}
                  onSelectionChange={(k) => {
                    if (!k) return;
                    const next = String(k) === CUSTOM ? 'custom.' : (String(k) as MappableField);
                    onChange({ ...mapping, [column]: next as MappableField });
                  }}
                  {...(showProblems && earlier
                    ? {
                        isInvalid: true,
                        errorMessage: t`${fieldName} is already ${earlier}. One column each.`,
                      }
                    : {})}
                />
                {isCustom ? (
                  <TextField
                    label={t`Field key`}
                    description={t`As the type's field is written in Settings → Account → Types, like warranty_months.`}
                    value={field.slice('custom.'.length)}
                    onChange={(v) =>
                      onChange({
                        ...mapping,
                        [column]: `custom.${v.trim().toLowerCase()}` as MappableField,
                      })
                    }
                    {...(showProblems && problems.badKey.includes(column)
                      ? {
                          isInvalid: true,
                          errorMessage: t`Lowercase letters, digits and _, starting with a letter.`,
                        }
                      : {})}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
