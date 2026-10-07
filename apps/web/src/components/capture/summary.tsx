/**
 * "Capture done" (screens §5; board frame 4): how many were captured and where, how many still
 * wait to sync (from the phone's queue), each capture with its state, and on iPhone "Open to
 * finish syncing (8)" because Safari uploads only while Kept is open (D36). IDs stay pending until
 * the server allocates them (D112). "Undo this batch" takes back what hasn't synced and asks the
 * server to trash the rest of this batch's unreviewed drafts.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckIcon, ClockIcon, CloudOffIcon, DocumentIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';

export type SummaryShot = {
  key: string;
  thumb: string | null;
  waiting: boolean;
};

export function CaptureSummary({
  shots,
  where,
  waiting,
  iphone,
  asOf,
  aiOn,
  onKeepCapturing,
  onDone,
  onUndo,
  undoing,
}: {
  shots: readonly SummaryShot[];
  /** "Garage › Shelf A", or null when the batch went to several places. */
  where: string | null;
  waiting: number;
  iphone: boolean;
  asOf: string | null;
  aiOn: boolean;
  onKeepCapturing: () => void;
  onDone: () => void;
  onUndo: (() => void) | null;
  undoing: boolean;
}) {
  const { t } = useLingui();
  const n = shots.length;
  const synced = n - waiting;
  const head = where
    ? plural(n, { one: `# captured into ${where}`, other: `# captured into ${where}` })
    : plural(n, { one: '# captured', other: '# captured' });
  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr_auto] bg-paper text-ink md:min-h-0">
      <header className="flex min-h-14 items-center border-b border-line bg-surface px-4">
        <h1 className="m-0 font-semibold text-title">
          <Trans>Capture done</Trans>
        </h1>
      </header>
      <div className="grid content-start gap-3 p-4">
        <span className="grid size-[52px] place-items-center rounded-full bg-sunken text-ok [&_svg]:size-7">
          <CheckIcon strokeWidth="2.2" />
        </span>
        <p className="m-0 font-semibold text-[21px] leading-snug [overflow-wrap:anywhere]">
          <bdi>{head}</bdi>
        </p>
        <div className="flex flex-wrap gap-2 text-[13px]">
          {waiting > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 [&_svg]:size-4">
              <ClockIcon />
              {plural(waiting, { one: '# waiting to sync', other: '# waiting to sync' })}
            </span>
          ) : null}
          {synced > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok px-2.5 py-1 text-ok [&_svg]:size-4">
              <CheckIcon />
              {plural(synced, { one: '# synced', other: '# synced' })}
            </span>
          ) : null}
        </div>
        {iphone && waiting > 0 ? (
          <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-sunken p-3 text-small text-ink-2 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-info">
            <CloudOffIcon />
            <span>
              <b className="text-ink">
                {plural(waiting, {
                  one: 'Open to finish syncing (#).',
                  other: 'Open to finish syncing (#).',
                })}
              </b>{' '}
              <Trans>
                On iPhone, Kept uploads only while it's open. Keep it open when you're back in
                signal.
              </Trans>
            </span>
          </div>
        ) : null}
        <ul aria-label={t`This batch`} className="m-0 grid list-none grid-cols-6 gap-1.5 p-0">
          {shots.map((s) => (
            <li
              key={s.key}
              className="relative grid aspect-square place-items-center overflow-hidden rounded-[10px] bg-sunken text-ink-3"
            >
              {s.thumb ? (
                <img src={s.thumb} alt="" className="size-full object-cover" />
              ) : (
                <DocumentIcon className="size-6" />
              )}
              <span
                role="img"
                aria-label={s.waiting ? t`Waiting · ID pending` : t`Synced`}
                className={`absolute end-0.5 bottom-0.5 grid size-5 place-items-center rounded-full border border-line bg-surface [&_svg]:size-3 ${s.waiting ? 'text-ink-2' : 'text-ok'}`}
              >
                {s.waiting ? <ClockIcon /> : <CheckIcon strokeWidth="3" />}
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-[12.5px] text-ink-3">
          {aiOn ? (
            <Trans>
              Each one is saved and findable on this phone now. AI fills in details after sync;
              anything that needs you lands in the Inbox.
            </Trans>
          ) : (
            <Trans>
              Each one is saved and findable on this phone now. Unnamed ones wait in the Inbox for a
              name.
            </Trans>
          )}
        </p>
        {asOf ? <p className="m-0 text-[12px] text-ink-3">{t`As of last sync, ${asOf}`}</p> : null}
        {onUndo ? (
          <div>
            <Button variant="ghost" onPress={onUndo} isPending={undoing}>
              <Trans>Undo this batch</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      <footer className="flex gap-2 border-t border-line bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button variant="secondary" className="flex-1" onPress={onKeepCapturing}>
          <Trans>Keep capturing</Trans>
        </Button>
        <Button className="flex-1" onPress={onDone}>
          <Trans>Done</Trans>
        </Button>
      </footer>
    </div>
  );
}
