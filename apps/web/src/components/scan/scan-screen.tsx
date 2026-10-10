/**
 * Scan (D137, D175; screens §5, §6, §8; plan T26; board frames 5a–5c, 7a–7c). A focused task: on
 * the phone it covers the tab bar with its own chrome, dark in every theme like the capture camera.
 *
 * - Point the camera at a label or a barcode; each read is resolved (./resolve.ts): the phone
 *   first, then the server. A Kept label for something you can see opens it at once and marks it
 *   seen (D40); every other outcome answers in a sheet over the camera.
 * - "Type the code" is always there (and leads when the camera or the decoder can't be used).
 * - **Tray mode** (`?tray=1`, "Scan destination"): a scanned thing is picked up; a scanned place
 *   or box is where everything carried goes, in one move with Undo (D175).
 * - A code read offline that the phone doesn't know is kept, and checked here once online.
 *
 * Service-worker updates wait while it is open (T23). The device (camera, decoder, connection) is
 * injectable for tests.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Detect } from '@/camera/label-recogniser';
import { appDetect } from '@/camera/scanner';
import type { CameraEnv } from '@/camera/session';
import { useHint } from '@/components/hints/use-hint';
import { QrIcon, XIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { usePlaceName } from '@/components/places/labels';
import { Sheet } from '@/components/things/sheet';
import { moveCarried } from '@/components/tray/move';
import { TraySheet, useAfterMove } from '@/components/tray/tray';
import { TrayFooter } from '@/components/tray/tray-footer';
import { TrayIcon } from '@/components/tray/tray-icon';
import { useTray } from '@/components/tray/use-tray';
import { Button as UiButton } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import type { SyncNotice } from '@/offline/store';
import { useHoldUpdates } from '@/pwa/register';
import { type Described, describeTarget } from './describe';
import { ManualCode } from './manual-code';
import { AnswerFrame, ScanAnswer } from './outcome-sheet';
import {
  markSeen,
  pendingScans,
  type Read,
  type Resolution,
  type ResolveDeps,
  rememberPendingScan,
  resolveScan,
  type ScanStore,
  type ScanTarget,
} from './resolve';
import { ScannerView } from './scanner-view';

export type ScanScreenProps = {
  store: ScanStore | null;
  /** Looking for where the tray's things go (`?tray=1`). */
  tray?: boolean;
  onExit: () => void;
  /** Go to what a scan opened (the route navigates; marking seen is done here). Settles when the navigation does, so the caller can close up after it commits. */
  onOpen: (target: ScanTarget) => void | Promise<void>;
  /** After an op was queued: the sync engine's kick (T24). */
  onQueued?: () => void;
  // ----- the device, injectable -----
  online?: boolean;
  camera?: CameraEnv;
  detect?: Detect | null;
  server?: ResolveDeps['server'];
};

type Answer = {
  res: Resolution;
  described?: Described | null;
  seen?: boolean;
  /** Tray mode: a place or thing to put things into, or to pick up. */
  forTray?: boolean;
};

const darkBtn =
  'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-[10px] px-3.5 font-semibold text-[14px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-[#F2EFE9] [&_svg]:size-5';

export function ScanScreen({
  store,
  tray: trayAsked = false,
  onExit,
  onOpen,
  onQueued,
  online: onlineProp,
  camera,
  detect = appDetect(),
  server,
}: ScanScreenProps) {
  const { t } = useLingui();
  const browserOnline = useOnline();
  const online = onlineProp ?? browserOnline;
  const placeName = usePlaceName();
  useHoldUpdates(true);

  const [trayMode, setTrayMode] = useState(trayAsked);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [cantScan, setCantScan] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [pending, setPending] = useState<SyncNotice[]>([]);
  const busyRef = useRef(false);
  const tray = useTray(store);
  const carried = tray.ids ?? [];
  const after = useAfterMove(store);
  // The first time the scanner opens: one hint on the viewfinder, once per person (D138).
  const viewfinder = useRef<HTMLDivElement>(null);
  useHint('scan.first_open', viewfinder, { when: !trayMode });

  const readPending = useCallback(async () => setPending(await pendingScans(store)), [store]);
  useEffect(() => {
    void readPending();
  }, [readPending]);

  const deps = useCallback(
    (): ResolveDeps => ({ store, online, ...(server ? { server } : {}) }),
    [store, online, server],
  );

  const openTarget = useCallback(
    async (target: ScanTarget, alreadySeen = false) => {
      await onOpen(target);
      if (!alreadySeen)
        void markSeen(target, { store, online }).then((r) => {
          if (r === 'queued') onQueued?.();
        });
    },
    [onOpen, store, online, onQueued],
  );

  const handle = useCallback(
    async (read: Read) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await resolveScan(read, deps());
        if (res.outcome === 'not_on_phone') {
          await rememberPendingScan(store, res.text);
          void readPending();
        }
        if (res.outcome === 'open' && trayMode) {
          setAnswer({
            res,
            described: await describeTarget(res.target, { store, online }),
            forTray: true,
          });
          setManual(false);
          return;
        }
        if (res.outcome === 'open' && !res.legacy) {
          // The sheet closes when the navigation commits, never before: closing first lets the
          // sheet's history entry pop while the resolve is still running, and that pop lands
          // after the navigation and derails it (the URL ends back at /scan).
          await openTarget(res.target);
          setManual(false);
          return;
        }
        if (res.outcome === 'open') {
          const [described, seen] = await Promise.all([
            describeTarget(res.target, { store, online }),
            markSeen(res.target, { store, online }),
          ]);
          if (seen === 'queued') onQueued?.();
          setAnswer({ res, described, seen: seen !== 'skipped' });
          setManual(false);
          return;
        }
        setAnswer({ res });
        setManual(false);
      } catch {
        toast({ title: t`Couldn't look that up. Try again.`, tone: 'danger' });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [deps, store, online, trayMode, openTarget, onQueued, readPending, t],
  );

  const again = useCallback(() => setAnswer(null), []);

  const checkPending = async () => {
    const [first] = pending;
    if (!first?.code) return;
    await store?.dismissNotice?.(first.id);
    await readPending();
    await handle({ text: first.code });
  };

  const title = trayMode
    ? carried.length > 0
      ? t`Scan destination`
      : t`Scan to pick up`
    : t`Scan`;
  const paused = !!answer || busy || manual || trayOpen;

  return (
    <div
      data-focused-task="scan"
      className="fixed inset-0 z-40 flex flex-col bg-[#0F0E0D] pt-[env(safe-area-inset-top)] text-[#F2EFE9] md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:min-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-2xl"
    >
      <header className="flex items-center gap-2 px-2 py-2">
        <Button
          aria-label={t`Close scanner`}
          onPress={onExit}
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9] [&_svg]:size-6"
        >
          <XIcon />
        </Button>
        <h1 className="m-0 min-w-0 flex-1 font-semibold text-[18px]">{title}</h1>
        {carried.length > 0 && !trayMode ? (
          <Button
            onPress={() => setTrayOpen(true)}
            className={`${darkBtn} rounded-full border border-[#4A463F] px-3 text-[13px]`}
          >
            <TrayIcon />
            {plural(carried.length, { one: 'Carrying #', other: 'Carrying #' })}
          </Button>
        ) : null}
      </header>

      {online && pending.length > 0 ? (
        <div
          role="status"
          className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-[#34302A] bg-[#1E1C19] px-3 py-2 text-[13.5px]"
        >
          <span className="min-w-0 flex-1">
            {plural(pending.length, {
              one: '# scan from while you were offline',
              other: '# scans from while you were offline',
            })}
          </span>
          <Button
            onPress={() => void checkPending()}
            className={`${darkBtn} border border-[#4A463F]`}
          >
            <Trans>Check now</Trans>
          </Button>
        </div>
      ) : null}

      <div
        ref={viewfinder}
        className="relative mx-3 min-h-[260px] flex-1 overflow-hidden rounded-[14px] bg-[#1C1A17]"
      >
        <ScannerView
          detect={detect}
          paused={paused}
          onRead={(r) => void handle(r)}
          onProblem={() => setCantScan(true)}
          {...(camera ? { camera } : {})}
        />
        {busy ? (
          <span
            role="status"
            className="absolute inset-x-0 top-3 mx-auto w-fit rounded-full bg-[#0F0E0D]/85 px-3 py-1.5 font-medium text-[13px]"
          >
            <Trans>Looking it up…</Trans>
          </span>
        ) : null}
        {answer?.forTray ? (
          <TrayAnswer
            answer={answer}
            carried={carried}
            busy={busy}
            onAgain={again}
            onPickUp={async (id) => {
              await tray.add([id]);
              again();
            }}
            onTakeOut={async (id) => {
              await tray.remove([id]);
              again();
            }}
            onOpen={(target) => openTarget(target)}
            onMove={async (d) => {
              const to = d.kind === 'place' ? { placeId: d.id } : { containerId: d.id };
              try {
                const moved = await moveCarried({
                  store,
                  online,
                  thingIds: carried,
                  to,
                  locationId: d.locationId,
                });
                if (moved.via === 'queue') onQueued?.();
                const where = [
                  ...d.path.map((s) => s.name ?? placeName({ name: '', isUnplaced: true })),
                  d.name ?? '',
                ]
                  .filter(Boolean)
                  .join(' › ');
                after(
                  moved,
                  plural(carried.length, {
                    one: `Moved # thing to ${where}`,
                    other: `Moved # things to ${where}`,
                  }),
                );
                await tray.remove();
                again();
                openTarget({ kind: d.kind, id: d.id, locationId: d.locationId }, true);
              } catch {
                toast({ title: t`Couldn't move them. Try again.`, tone: 'danger' });
              }
            }}
          />
        ) : answer ? (
          <ScanAnswer
            res={answer.res}
            described={answer.described ?? null}
            seen={answer.seen ?? false}
            store={store}
            online={online}
            onCamera
            onOpen={(target) => openTarget(target, answer.seen === true)}
            onAgain={again}
            onDone={onExit}
            {...(onQueued ? { onQueued } : {})}
          />
        ) : null}
      </div>

      <div className="grid gap-2 px-3 pt-2.5 pb-3">
        {cantScan ? null : (
          <p className="m-0 text-center text-[#BDB7AC] text-[13px]">
            {trayMode ? (
              <Trans>Point at the label of the place or box they go in.</Trans>
            ) : (
              <Trans>Point at a Kept label, or a product's barcode.</Trans>
            )}
          </p>
        )}
        <Button
          onPress={() => setManual(true)}
          className={`${darkBtn} ${cantScan ? 'bg-amber text-amber-ink' : 'border border-[#4A463F]'}`}
        >
          <Trans>Type the code</Trans>
        </Button>
      </div>

      {trayMode && carried.length > 0 ? (
        <TrayFooter
          count={carried.length}
          onOpenTray={() => setTrayOpen(true)}
          onChoosePlace={() => setTrayOpen(true)}
        />
      ) : null}

      <Sheet isOpen={manual} onOpenChange={setManual} title={t`Type the code`}>
        <ManualCode
          onCancel={() => setManual(false)}
          onCode={(code) => {
            void handle({ text: code });
          }}
        />
      </Sheet>
      <TraySheet
        store={store}
        online={online}
        isOpen={trayOpen}
        onClose={() => setTrayOpen(false)}
        {...(trayMode
          ? {}
          : {
              onScan: () => {
                setTrayMode(true);
                setTrayOpen(false);
              },
            })}
        onMoved={(to) =>
          openTarget({ kind: 'place', id: to.placeId, locationId: to.locationId }, true)
        }
      />
    </div>
  );
}

/**
 * Tray mode's answer (board frame 7b): a place or a box → "Put the 3 things you're carrying here?"
 * · Move 3 here; a thing → Pick it up.
 */
function TrayAnswer({
  answer,
  carried,
  busy,
  onAgain,
  onPickUp,
  onTakeOut,
  onMove,
  onOpen,
}: {
  answer: Answer;
  carried: string[];
  busy: boolean;
  onAgain: () => void;
  onPickUp: (id: string) => Promise<void>;
  onTakeOut: (id: string) => Promise<void>;
  onMove: (d: Described) => Promise<void>;
  onOpen: (target: ScanTarget) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const placeName = usePlaceName();
  const [working, setWorking] = useState(false);
  const d = answer.described;
  const res = answer.res;
  if (res.outcome !== 'open') return null;
  const run = (fn: () => Promise<void>) => async () => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };
  const name =
    d?.name ?? (d?.kind === 'place' ? placeName({ name: '', isUnplaced: true }) : t`Unnamed`);
  const where = d?.path.map((s) => s.name ?? placeName({ name: '', isUnplaced: true })).join(' › ');
  const inTray = carried.includes(res.target.id);
  const canHold = d?.kind === 'place' || d?.isContainer === true;
  const n = carried.length;
  return (
    <AnswerFrame label={t`Scan result`} onCamera>
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2 [&_svg]:size-6">
          <QrIcon />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <bdi className="font-semibold [overflow-wrap:anywhere]">{name}</bdi>
            {d?.shortCode ? <IdChip code={d.shortCode} /> : null}
          </div>
          {where ? (
            <bdi className="text-small text-ink-3 [overflow-wrap:anywhere]">{where}</bdi>
          ) : null}
        </div>
      </div>
      {!d ? (
        <>
          <p className="m-0 text-ink-2">
            <Trans>Kept can't tell what this is from here.</Trans>
          </p>
          <UiButton onPress={() => onOpen(res.target)}>
            <Trans>Open it</Trans>
          </UiButton>
        </>
      ) : inTray ? (
        <>
          <p className="m-0 text-ink-2">
            <Trans>You're carrying this one.</Trans>
          </p>
          <UiButton
            variant="secondary"
            isPending={working}
            onPress={run(() => onTakeOut(res.target.id))}
          >
            <Trans>Take it out of the tray</Trans>
          </UiButton>
        </>
      ) : canHold && n > 0 ? (
        <>
          <p className="m-0 text-ink">
            {plural(n, {
              one: "Put the thing you're carrying here?",
              other: "Put the # things you're carrying here?",
            })}
          </p>
          <UiButton isPending={working || busy} onPress={run(() => onMove(d))}>
            {plural(n, { one: 'Move # here', other: 'Move # here' })}
          </UiButton>
          {d.kind === 'thing' ? (
            <UiButton variant="secondary" isPending={working} onPress={run(() => onPickUp(d.id))}>
              <Trans>Pick it up instead</Trans>
            </UiButton>
          ) : null}
        </>
      ) : d.kind === 'thing' ? (
        <UiButton isPending={working} onPress={run(() => onPickUp(d.id))}>
          <Trans>Pick it up</Trans>
        </UiButton>
      ) : (
        <p className="m-0 text-ink-2">
          <Trans>Pick things up first, then scan where they go.</Trans>
        </p>
      )}
      <UiButton variant="secondary" onPress={onAgain}>
        <Trans>Scan something else</Trans>
      </UiButton>
    </AnswerFrame>
  );
}
