/**
 * A Kept label in view, in any mode (D137; screens board frame 2): "Open Box 3" · "Capture into
 * Box 3", named from the phone's snapshot, so it works offline. A label for something not on
 * this phone is "a box" and can only be opened (the server answers, D137's six outcomes); a
 * blank label is opened to be claimed (T26). The shutter keeps working underneath.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from 'react-aria-components';
import { BoxIcon, XIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { sep } from '@/lib/format';

export type Recognised = {
  code: string;
  /** What the code is on this phone; `unknown` when the snapshot doesn't have it. */
  kind: 'container' | 'thing' | 'place' | 'blank' | 'unknown';
  id?: string;
  locationId?: string;
  name: string | null;
  /** "Storage unit › Shelf A". */
  where?: string;
};

const btn =
  'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] px-3.5 font-semibold text-[14px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-[#F2EFE9]';

export function RecognisedLabel({
  label,
  asOf,
  onOpen,
  onCaptureInto,
  onDismiss,
}: {
  label: Recognised;
  asOf: string | null;
  onOpen: () => void;
  onCaptureInto: (() => void) | null;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const name = label.name ?? (label.kind === 'blank' ? t`Blank label` : t`a box`);
  return (
    <section
      aria-label={t`Kept label in view`}
      className="absolute inset-x-2.5 bottom-2.5 z-10 grid gap-2.5 rounded-[14px] border border-[#34302A] bg-[#1E1C19] p-3 text-[#F2EFE9]"
    >
      <div className="flex items-center gap-2.5">
        <BoxIcon className="size-[22px] shrink-0" />
        <bdi className="min-w-0 flex-1 font-semibold text-[16px] [overflow-wrap:anywhere]">
          {name}
        </bdi>
        <IdChip code={label.code} />
        <Button
          aria-label={t`Not now`}
          onPress={onDismiss}
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9] [&_svg]:size-5"
        >
          <XIcon />
        </Button>
      </div>
      {label.kind === 'unknown' ? (
        <p className="m-0 text-[#BDB7AC] text-[13px]">
          <Trans>Not on this phone. Kept checks it when you open it online.</Trans>
        </p>
      ) : label.where ? (
        <p className="m-0 text-[#BDB7AC] text-[13px]">
          <bdi>{label.where}</bdi>
          {asOf ? (
            <>
              {sep()}
              {t`from this phone, as of last sync ${asOf}`}
            </>
          ) : null}
        </p>
      ) : null}
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button onPress={onOpen} className={`${btn} border border-[#4A463F] bg-transparent`}>
          {label.kind === 'blank' ? t`Claim it` : label.name ? t`Open ${name}` : t`Open`}
        </Button>
        {onCaptureInto ? (
          <Button onPress={onCaptureInto} className={`${btn} bg-amber text-amber-ink`}>
            {t`Capture into ${name}`}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
