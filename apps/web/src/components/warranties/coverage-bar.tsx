/**
 * The coverage bar (D195): bought → today → covered until, one per active warranty. It starts on
 * the thing's purchase date when that is known and not after the warranty's start (an extended
 * warranty that starts when the maker's ends still runs from the day it was bought; UI step-4
 * review L4), else on the warranty's start. The filled part is the time used; the marker is today. A lifetime warranty has no end: its bar
 * reads "Lifetime". It follows the reading direction (inset-inline-start), so it runs right to
 * left in Arabic, and it's one image to a screen reader, with the dates in its name.
 */
import { useLingui } from '@lingui/react/macro';
import { daysBetween } from '@/components/schedules/access';
import { useFormat } from '@/lib/format';

export function CoverageBar({
  boughtOn,
  startsOn,
  endsOn,
  today,
}: {
  /** The thing's purchase date, when known. */
  boughtOn?: string | null;
  startsOn: string;
  /** The last covered day, or null for lifetime. */
  endsOn: string | null;
  today: string;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const bought = boughtOn && boughtOn < startsOn ? boughtOn : null;
  const start = bought ?? startsOn;
  const from = fmt.day(startsOn);
  const first = fmt.day(start);
  const until = endsOn ? fmt.day(endsOn) : t`Lifetime`;
  const span = endsOn ? Math.max(1, daysBetween(start, endsOn)) : 1;
  const used = endsOn ? Math.min(1, Math.max(0, daysBetween(start, today) / span)) : 1;
  const pct = `${Math.round(used * 100)}%`;
  const label = !endsOn
    ? t`Covered for life, from ${from}`
    : bought
      ? t`Bought ${first}, covered from ${from} to ${until}; today is ${pct} of the way`
      : t`Covered from ${from} to ${until}; today is ${pct} of the way`;
  return (
    <div role="img" aria-label={label} className="grid gap-1">
      <div className="relative h-2 rounded-full bg-sunken">
        <div
          className="absolute inset-y-0 start-0 rounded-full bg-ok/60"
          style={{ inlineSize: endsOn ? pct : '100%' }}
        />
        {endsOn ? (
          <div
            aria-hidden="true"
            className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink rtl:translate-x-1/2"
            style={{ insetInlineStart: pct }}
          />
        ) : null}
      </div>
      <div aria-hidden="true" className="flex justify-between gap-2 text-[12px] text-ink-3">
        <span>{endsOn ? first : from}</span>
        {endsOn ? <span className="text-ink-2">{t`Today`}</span> : null}
        <span>{until}</span>
      </div>
    </div>
  );
}
