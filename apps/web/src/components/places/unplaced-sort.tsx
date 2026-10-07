/**
 * The Unplaced area and "Sort them" (D118, screens §5 Location-only). The card says how many
 * things were captured into a location with no place yet; Sort them walks through them one at a
 * time with the move picker (Skip leaves one where it is). To move several at once, open the
 * Unplaced area and use Select.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { PlaceNode, ThingRow } from '@/api/inventory/types';
import { CheckCircleIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { LoadingRows } from '@/components/page';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { addressOf } from '@/lib/address';
import { useFormat } from '@/lib/format';
import { useThingsQuery } from './api';
import { MoveThingsForm } from './move-picker';
import { Tile } from './rows';
import { Sheet } from './sheet';

export function UnplacedCard({
  unplaced,
  locationId,
  locationName,
  canEdit,
}: {
  unplaced: PlaceNode;
  locationId: string;
  locationName: string;
  canEdit: boolean;
}) {
  const f = useFormat();
  const [sorting, setSorting] = useState(false);
  if (unplaced.thingCount === 0) return null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 py-2.5">
      <span className="font-mono font-semibold text-[22px] tabular-nums text-ink">
        {f.num(unplaced.thingCount)}
      </span>
      <Link
        to="/p/$id"
        params={{ id: addressOf(unplaced) }}
        className="grid min-w-0 flex-1 gap-0.5 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-info"
      >
        <span className="font-semibold text-[15px] text-ink">
          <Trans>Unplaced</Trans>
        </span>
        <span className="text-small text-ink-2">
          <Trans>
            Captured into <bdi>{locationName}</bdi>, no place yet
          </Trans>
        </span>
      </Link>
      {canEdit ? (
        <Button size="small" variant="secondary" onPress={() => setSorting(true)}>
          <Trans>Sort them</Trans>
        </Button>
      ) : null}
      {sorting ? (
        <SortUnplaced
          unplacedId={unplaced.id}
          locationId={locationId}
          onClose={() => setSorting(false)}
        />
      ) : null}
    </div>
  );
}

/** One-at-a-time triage over a snapshot of the Unplaced things taken when it opened. */
export function SortUnplaced({
  unplacedId,
  locationId,
  onClose,
}: {
  unplacedId: string;
  locationId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const query = useThingsQuery({ locationId, placeId: unplacedId, limit: 200 }, true);
  const [queue, setQueue] = useState<ThingRow[] | null>(null);
  const [index, setIndex] = useState(0);
  const [moved, setMoved] = useState(0);
  if (queue === null && query.data) setQueue(query.data.pages.flatMap((pg) => pg.items));
  const current = queue?.[index];
  const total = queue?.length ?? 0;
  const n = index + 1;
  return (
    <Sheet
      isOpen
      wide
      onOpenChange={(open) => !open && onClose()}
      title={current ? t`Sort Unplaced · ${n} of ${total}` : t`Sort Unplaced`}
    >
      {({ close }) =>
        queue === null ? (
          <LoadingRows rows={2} />
        ) : current ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-3 rounded-[10px] bg-sunken p-3">
              <Tile className="bg-surface">
                {current.thumbUrl ? (
                  <img src={current.thumbUrl} alt="" className="size-full object-cover" />
                ) : (
                  <TypeIcon icon={current.type?.icon} />
                )}
              </Tile>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="font-semibold text-[16px] [overflow-wrap:anywhere]">
                  {current.name ? <bdi>{current.name}</bdi> : <Trans>Untitled draft</Trans>}
                </span>
                <IdChip code={current.shortCode} />
              </span>
            </div>
            <MoveThingsForm
              key={current.id}
              thingIds={[current.id]}
              fromLocationId={current.locationId}
              exclude={new Set([unplacedId])}
              cancelLabel={t`Skip`}
              onCancel={() => setIndex((i) => i + 1)}
              onMoved={() => {
                setMoved((m) => m + 1);
                setIndex((i) => i + 1);
              }}
            />
          </div>
        ) : (
          <div className="grid justify-items-center gap-3 py-2 text-center">
            <CheckCircleIcon className="size-8 text-ok" />
            <p className="m-0 text-ink-2">
              {moved === 0 ? (
                <Trans>Nothing moved. They're still in Unplaced.</Trans>
              ) : (
                <Plural
                  value={moved}
                  one="# thing has a place now."
                  other="# things have a place now."
                />
              )}
            </p>
            <DialogFooter className="justify-center">
              <Button onPress={close}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </div>
        )
      }
    </Sheet>
  );
}
