/**
 * Sheets of the board (1.x, D251): adding a numbered box, and the contents sheets PDF.
 *
 * - **Add a box** makes the next numbered box ("Box 7") in the location being packed (in its
 *   Unplaced area until it is moved), with the room it goes to when you know it. Its number comes from the server, so it
 *   needs a connection. A label for it prints from Labels (Print labels on the board).
 * - **Contents sheets** is a PDF made on the server (`POST /reports/move`, the `move` run kind): a
 *   page per box, with its number, the room it goes to, what is inside and its QR code, to tape to
 *   the box. Followed to Open PDF, Share and Download (components/reports/progress.tsx).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { movingApi } from '@/api/moving/queries';
import type { ContentsSheetsBody, Move } from '@/api/moving/types';
import { Notice, useErrorText } from '@/components/page';
import { type PickedPlace, PlacePicker } from '@/components/places/move-picker';
import { ReportProgress, reportFilenameOf } from '@/components/reports/progress';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';
import { useRefreshBoard } from './offline';

const filename = reportFilenameOf('contents-sheets');

export function AddBoxSheet({
  isOpen,
  onClose,
  move,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  move: Move;
  onAdded?: (containerId: string, number: number) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Add a box`}>
      {isOpen ? <AddBoxForm move={move} onClose={onClose} onAdded={onAdded} /> : null}
    </Sheet>
  );
}

function AddBoxForm({
  move,
  onClose,
  onAdded,
}: {
  move: Move;
  onClose: () => void;
  onAdded?: ((containerId: string, number: number) => void) | undefined;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const errorText = useErrorText();
  const refresh = useRefreshBoard();
  const [room, setRoom] = useState<PickedPlace | null>(null);
  const add = useMutation({
    mutationFn: () =>
      movingApi.addBox(move.id, {
        new: { prefix: t`Box` },
        ...(room ? { destinationPlaceId: room.placeId } : {}),
      }),
    onSuccess: async (box) => {
      await refresh(move.id);
      onAdded?.(box.containerId, box.number);
      onClose();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>It gets the next number. Put things in it from its page, or with the scanner.</Trans>
      </p>
      <PlacePicker
        label={t`Room it goes to (optional)`}
        locationIds={[move.toLocationId ?? move.locationId]}
        includeUnplaced={false}
        value={room}
        onChange={setRoom}
      />
      {add.error ? <Notice tone="danger">{errorText(add.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={add.isPending} isDisabled={!online}>
          <Trans>Add the box</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ContentsSheetsSheet({
  isOpen,
  onClose,
  move,
  containerIds,
}: {
  isOpen: boolean;
  onClose: () => void;
  move: Move;
  /** Only these boxes; omitted: every box. */
  containerIds?: string[] | undefined;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Contents sheets`}>
      {isOpen ? <SheetsForm onClose={onClose} move={move} containerIds={containerIds} /> : null}
    </Sheet>
  );
}

function SheetsForm({
  onClose,
  move,
  containerIds,
}: {
  onClose: () => void;
  move: Move;
  containerIds?: string[] | undefined;
}) {
  const { t } = useLingui();
  const prefs = usePrefs();
  const online = useOnline();
  const errorText = useErrorText();
  const [locale, setLocale] = useState<'en' | 'ar'>(prefs.locale === 'ar' ? 'ar' : 'en');
  const [runId, setRunId] = useState<string | null>(null);
  const body = (): ContentsSheetsBody => ({
    moveId: move.id,
    ...(containerIds?.length ? { containerIds } : {}),
    locale,
    digits: locale === 'ar' ? prefs.digits : 'western',
  });
  const start = useMutation({
    mutationFn: (b: ContentsSheetsBody) => movingApi.sheets(b),
    onSuccess: ({ id }) => setRunId(id),
  });
  const startError = (e: unknown) =>
    isApiError(e) && e.code === 'rate_limited'
      ? t`Kept makes at most five reports an hour. Try again later.`
      : errorText(e);

  if (runId)
    return (
      <div className="grid gap-4">
        <ReportProgress
          key={runId}
          runId={runId}
          filename={filename}
          onRetry={() => {
            setRunId(null);
            start.mutate(body());
          }}
        />
        {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </div>
    );

  const n = containerIds?.length ?? move.boxes.length;
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate(body());
      }}
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>
          A page per box: its number, the room it goes to, what's inside and its code. Tape it to
          the box; scanning the code opens the box in Kept.
        </Trans>
      </p>
      {n === 0 ? (
        <Notice tone="warn">
          <Trans>Add a box first.</Trans>
        </Notice>
      ) : null}
      <Segmented<'en' | 'ar'>
        label={t`Language`}
        value={locale}
        onChange={setLocale}
        options={[
          { id: 'en', label: 'English' },
          { id: 'ar', label: <span lang="ar">العربية</span> },
        ]}
      />
      {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={start.isPending} isDisabled={!online || n === 0}>
          <Trans>Make the PDF</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
