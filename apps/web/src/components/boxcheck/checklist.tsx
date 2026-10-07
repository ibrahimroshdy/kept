/**
 * The box check's list (D40, screens §6 and §8; board frame 3): a checkbox per row; a quantity
 * row, once ticked, counts how many are there ("Found 2 of 3", and "1 will be marked not here",
 * because the missing part splits off as a row of its own, D10); a box inside is one line,
 * "not opened". Things found that belong elsewhere are listed apart: they move into this box.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Checkbox } from 'react-aria-components';
import { AlertIcon, BoxIcon, CheckIcon, XIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { Button } from '@/components/ui/button';
import { CountStepper } from './count-stepper';
import type { BoxLine } from './load';

/** Only whole quantities above 1 get a stepper; anything else is there or not (D183). */
export const counted = (line: BoxLine) => Number.isInteger(line.quantity) && line.quantity > 1;

export function Tick({ isSelected }: { isSelected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-6 shrink-0 place-items-center rounded-md border-2 [&_svg]:size-4 ${
        isSelected ? 'border-ink bg-ink text-surface' : 'border-ink-3 bg-surface'
      }`}
    >
      {isSelected ? <CheckIcon /> : null}
    </span>
  );
}

export function Checklist({
  lines,
  found,
  onFound,
}: {
  lines: readonly BoxLine[];
  found: Readonly<Record<string, number>>;
  onFound: (id: string, n: number) => void;
}) {
  const { t } = useLingui();
  return (
    <ul
      aria-label={t`What the box should hold`}
      className="m-0 grid list-none overflow-hidden rounded-xl border border-line bg-surface p-0"
    >
      {lines.map((line) => {
        const n = found[line.id] ?? 0;
        const ticked = n > 0;
        const name = line.name ?? t`Unnamed`;
        const missing = line.quantity - n;
        return (
          <li key={line.id} className="grid gap-1.5 border-line px-3 py-2 not-first:border-t">
            <div className="flex min-h-11 items-center gap-3">
              <Checkbox
                isSelected={ticked}
                onChange={(on) => onFound(line.id, on ? line.quantity : 0)}
                aria-label={name}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info"
              >
                {({ isSelected }) => (
                  <>
                    <Tick isSelected={isSelected} />
                    <span className="grid min-w-0 flex-1">
                      <bdi className="font-semibold [overflow-wrap:anywhere]">{name}</bdi>
                      {line.isContainer ? (
                        <span className="flex items-center gap-1 text-small text-ink-3 [&_svg]:size-4">
                          <BoxIcon />
                          {line.inside === null
                            ? t`Box inside · not opened`
                            : plural(line.inside, {
                                one: 'Box inside · # thing, not opened',
                                other: 'Box inside · # things, not opened',
                              })}
                        </span>
                      ) : counted(line) && !ticked ? (
                        <span className="text-small text-ink-3">
                          {plural(line.quantity, { one: '# of them', other: '# of them' })}
                        </span>
                      ) : null}
                    </span>
                  </>
                )}
              </Checkbox>
              <IdChip code={line.shortCode} pending={line.shortCode === null} />
            </div>
            {ticked && counted(line) ? (
              <div className="grid gap-1 ps-9">
                <CountStepper
                  value={n}
                  max={line.quantity}
                  name={name}
                  onChange={(v) => onFound(line.id, v)}
                />
                {missing > 0 ? (
                  <p className="m-0 flex items-center gap-1.5 text-small text-warn [&_svg]:size-4">
                    <AlertIcon />
                    {plural(missing, {
                      one: '# will be marked not here',
                      other: '# will be marked not here',
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What was found here that belongs elsewhere: it moves into the box when the check is done. */
export function FoundElsewhere({
  items,
  onRemove,
}: {
  items: readonly { id: string; name: string | null; shortCode: string | null }[];
  onRemove: (id: string) => void;
}) {
  const { t } = useLingui();
  if (items.length === 0) return null;
  return (
    <section aria-label={t`Found here, from elsewhere`} className="grid gap-1.5">
      <h2 className="m-0 font-semibold text-[12.5px] text-ink-3 uppercase tracking-[0.06em]">
        <Trans>Found here · moves into this box</Trans>
      </h2>
      <ul className="m-0 grid list-none overflow-hidden rounded-xl border border-line bg-surface p-0">
        {items.map((it) => (
          <li
            key={it.id}
            className="flex min-h-12 items-center gap-3 border-line px-3 py-1.5 not-first:border-t"
          >
            <bdi className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
              {it.name ?? t`Unnamed`}
            </bdi>
            <IdChip code={it.shortCode} pending={it.shortCode === null} />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Leave ${it.name ?? ''} out`}
              onPress={() => onRemove(it.id)}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
