/**
 * A scan's answer (D137's six outcomes; screens §8; board frames 5a–5c). On the scanner it is a
 * sheet over the camera; on a `/l/<code>` page, a card. Every answer is plain, and "Not in your
 * Kept" reads the same whatever the reason (another household's label, a location you left, a
 * deleted thing), so a scan never shows that a label exists somewhere else.
 *
 * - open (a Kept code) → the caller has already opened it; only an old label shows here (5c);
 * - claim → claim-sheet.tsx; several old labels → legacy-picker.tsx; a product → barcode-sheet.tsx;
 * - not in your Kept · not on this phone · not a Kept label → what it is, Scan again, Done.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { CheckCircleIcon, CloudOffIcon, LinkIcon, QrIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { Pill } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BarcodeSheet } from './barcode-sheet';
import { ClaimSheet } from './claim-sheet';
import type { Described } from './describe';
import { LegacyPicker } from './legacy-picker';
import type { Resolution, ScanStore, ScanTarget } from './resolve';

/** The answer's frame: a sheet on the camera, a card on a page. */
export function AnswerFrame({
  label,
  onCamera,
  children,
}: {
  label: string;
  onCamera: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'grid gap-2.5 bg-surface p-4 text-ink',
        onCamera
          ? 'absolute inset-x-0 bottom-0 z-10 max-h-[85%] overflow-y-auto rounded-t-[18px] pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-10px_30px_rgba(0,0,0,.25)]'
          : 'rounded-xl border border-line',
      )}
    >
      {onCamera ? (
        <span aria-hidden="true" className="mx-auto -mt-1.5 h-1 w-10 rounded-full bg-line" />
      ) : null}
      {children}
    </section>
  );
}

/** "Label 4TW‑8HC", as the label prints it. */
export function LabelLine({ code }: { code: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2">
      <span className="text-small text-ink-3">
        <Trans>Label</Trans>
      </span>
      <IdChip code={code} />
    </div>
  );
}

function Headline({ icon, title }: { icon: ReactNode; title: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2">
      <span className="grid size-11 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-6">
        {icon}
      </span>
      <h2 className="m-0 font-semibold text-[19px] [overflow-wrap:anywhere]">{title}</h2>
    </div>
  );
}

export function AgainOrDone({ onAgain, onDone }: { onAgain: () => void; onDone: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="secondary" onPress={onAgain}>
        <Trans>Scan again</Trans>
      </Button>
      <Button onPress={onDone}>
        <Trans>Done</Trans>
      </Button>
    </div>
  );
}

export type AnswerProps = {
  res: Resolution;
  /** For an old label's answer (5c): what it opened, and whether it was marked seen. */
  described?: Described | null;
  seen?: boolean;
  store: ScanStore | null;
  online: boolean;
  onCamera: boolean;
  onOpen: (target: ScanTarget) => void;
  onAgain: () => void;
  onDone: () => void;
  onQueued?: () => void;
};

export function ScanAnswer(props: AnswerProps) {
  const { res, onCamera, onAgain, onDone } = props;
  const { t } = useLingui();
  const placeName = usePlaceName();
  switch (res.outcome) {
    case 'claim':
      return <ClaimSheet {...props} code={res.code} locationId={res.locationId} />;
    case 'legacy_ambiguous':
      return (
        <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
          <LegacyPicker legacy={res.legacy} candidates={res.candidates} onOpen={props.onOpen} />
          <AgainOrDone onAgain={onAgain} onDone={onDone} />
        </AnswerFrame>
      );
    case 'barcode':
      return <BarcodeSheet {...props} code={res.code} lookupEnabled={res.lookupEnabled} />;
    case 'not_in_your_kept':
      return (
        <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
          <Headline icon={<QrIcon />} title={<Trans>Not in your Kept</Trans>} />
          <p className="m-0 text-ink-2">
            <Trans>Nothing in the locations you belong to has this label.</Trans>
          </p>
          {res.code ? <LabelLine code={res.code} /> : null}
          <AgainOrDone onAgain={onAgain} onDone={onDone} />
        </AnswerFrame>
      );
    case 'not_on_phone':
      return (
        <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
          <Headline icon={<CloudOffIcon />} title={<Trans>Not on this phone</Trans>} />
          <p className="m-0 text-ink-2">
            <Trans>It will check when you're online.</Trans>
          </p>
          {res.code ? <LabelLine code={res.code} /> : <ReadText text={res.text} />}
          <AgainOrDone onAgain={onAgain} onDone={onDone} />
        </AnswerFrame>
      );
    case 'not_kept':
      return (
        <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
          <Headline icon={<QrIcon />} title={<Trans>Not a Kept label</Trans>} />
          <p className="m-0 text-ink-2">
            <Trans>This code isn't one of Kept's labels. It says:</Trans>
          </p>
          <ReadText text={res.text} />
          <AgainOrDone onAgain={onAgain} onDone={onDone} />
        </AnswerFrame>
      );
    case 'open': {
      // A Kept code opens at once; only an old label stops here to say what it was (5c).
      const d = props.described;
      const name = d?.name ?? null;
      return (
        <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
          <Pill tone="info" icon={<LinkIcon />}>
            <Trans>Old Homebox label</Trans>
          </Pill>
          <h2 className="m-0 font-semibold text-[19px] [overflow-wrap:anywhere]">
            <bdi dir="ltr" className="font-mono">
              {t`Asset ${res.legacy ?? ''}`}
            </bdi>
            {name ? (
              <>
                {' '}
                → <bdi>{name}</bdi>
              </>
            ) : null}
          </h2>
          {d ? (
            <div className="grid gap-1 rounded-lg border border-line p-3">
              <bdi className="font-semibold">{d.name}</bdi>
              {d.path.length ? (
                <bdi className="text-small text-ink-3">
                  {d.path
                    .map((s) => s.name ?? placeName({ name: '', isUnplaced: true }))
                    .join(' › ')}
                </bdi>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <IdChip code={d.shortCode} pending={d.shortCode === null} />
                {props.seen ? (
                  <Pill tone="ok" icon={<CheckCircleIcon />}>
                    <Trans>Seen just now</Trans>
                  </Pill>
                ) : null}
              </div>
            </div>
          ) : null}
          <p className="m-0 text-small text-ink-3">
            <Trans>The old label keeps working.</Trans>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onPress={onAgain}>
              <Trans>Scan again</Trans>
            </Button>
            <Button onPress={() => props.onOpen(res.target)}>
              {name ? t`Open ${name}` : t`Open`}
            </Button>
          </div>
        </AnswerFrame>
      );
    }
  }
}

/** What a code said, shown as text: selectable, and never opened as a link (D137 case 5). */
function ReadText({ text }: { text: string }) {
  return (
    <p
      dir="auto"
      className="m-0 max-h-28 overflow-y-auto rounded-lg bg-sunken px-3 py-2 font-mono text-small text-ink [overflow-wrap:anywhere] select-text"
    >
      {text}
    </p>
  );
}
