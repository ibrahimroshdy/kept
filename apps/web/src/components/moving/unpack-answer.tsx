/**
 * Scan to unpack (1.x, D251): the scanner's answer when it is opened from a move's board
 * (`/scan?unpack=<move id>`). A box of the move, by its label or its contents sheet's code, opens
 * the unpack panel over the camera: the room it goes to, then Unpack, and the next box can be
 * scanned at once. Works offline from the phone's copy of the board (./offline.ts).
 */
import type { MoveStatus } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { BoxIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { LoadingRows, Pill } from '@/components/page';
import { AnswerFrame } from '@/components/scan/outcome-sheet';
import type { ScanTarget } from '@/components/scan/resolve';
import { Button } from '@/components/ui/button';
import type { OfflineStore } from '@/offline/store';
import { UnpackPanel } from './box-write';
import { STATE_TONES, useBoxStateLabels, useBoxTitle } from './labels';
import { useBoard } from './offline';

export function UnpackAnswer({
  moveId,
  target,
  store,
  online,
  onQueued,
  onAgain,
  onOpen,
}: {
  moveId: string;
  target: ScanTarget;
  store: OfflineStore | null;
  online: boolean;
  onQueued?: (() => void) | undefined;
  onAgain: () => void;
  onOpen: (target: ScanTarget) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const board = useBoard(moveId, { store, online });
  const states = useBoxStateLabels();
  const boxTitle = useBoxTitle();
  const move = board.data?.move;
  const box =
    target.kind === 'thing' ? move?.boxes.find((b) => b.containerId === target.id) : undefined;
  const status: MoveStatus | undefined = move?.status;
  return (
    <AnswerFrame label={t`Scan result`} onCamera>
      {board.isPending ? (
        <LoadingRows rows={2} label={t`Loading the move`} />
      ) : !move || !box ? (
        <>
          <p className="m-0 font-semibold">
            <Trans>Not a box of this move</Trans>
          </p>
          <Button variant="secondary" onPress={() => onOpen(target)}>
            <Trans>Open it</Trans>
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2 [&_svg]:size-6">
              <BoxIcon />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{boxTitle(box.number)}</span>
                {box.shortCode ? <IdChip code={box.shortCode} /> : null}
                <Pill tone={STATE_TONES[box.state]}>{states[box.state]}</Pill>
              </div>
              {box.name && box.name !== boxTitle(box.number) ? (
                <bdi className="text-small text-ink-3 [overflow-wrap:anywhere]">{box.name}</bdi>
              ) : null}
            </div>
          </div>
          {box.state === 'unpacked' ? (
            <p className="m-0 text-ink-2">
              {box.destination ? (
                <Trans>
                  Already unpacked into <bdi>{box.destination.name}</bdi>.
                </Trans>
              ) : (
                <Trans>Already unpacked.</Trans>
              )}
            </p>
          ) : status === 'done' ? (
            <p className="m-0 text-ink-2">
              <Trans>This move is marked done. Open it again to change its boxes.</Trans>
            </p>
          ) : (
            <UnpackPanel
              store={store}
              online={online}
              onQueued={onQueued}
              move={move}
              box={box}
              onDone={onAgain}
            />
          )}
        </>
      )}
      <Button variant="secondary" onPress={onAgain}>
        <Trans>Scan another box</Trans>
      </Button>
    </AnswerFrame>
  );
}
