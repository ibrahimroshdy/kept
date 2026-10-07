/**
 * The odometer proof strip (plan T18; D27, D195; screens §5): the dashboard photos that prove the
 * meter's readings, newest first, in one row that scrolls sideways, each with its value and date.
 * A photo opens larger in a sheet, with the ones beside it a press away. A step-3 proof still on
 * the thing (no reading yet) shows its date alone (Q10). The vehicle history report reuses the
 * same photos (T15).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import { useProofs } from '@/api/vehicles/queries';
import type { ProofItem } from '@/api/vehicles/types';
import { CameraIcon, ChevronEndIcon, ChevronStartIcon } from '@/components/icons';
import { Section, Skeleton } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';

export function ProofStrip({ meterId, unit }: { meterId: string; unit: string }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const q = useProofs(meterId);
  const [open, setOpen] = useState<number | null>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <Skeleton className="h-32" />;
  if (items.length === 0) return null;
  const readingOf = (p: ProofItem) =>
    p.value ? `${fmt.num(Number(p.value))} ${unitOf(unit)}` : null;
  return (
    <Section title={<Trans>Proof photos</Trans>}>
      <ul
        aria-label={t`Proof photos`}
        className="m-0 flex list-none gap-2 overflow-x-auto overscroll-x-contain p-0 pb-1"
      >
        {items.map((p, i) => (
          <li key={`${p.fileId}:${p.readingId ?? ''}`} className="shrink-0">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="grid w-28 gap-1 rounded-[10px] text-start outline-none focus-visible:outline-2 focus-visible:outline-info"
              aria-label={
                readingOf(p)
                  ? t`Proof photo, ${readingOf(p)}, ${fmt.day(p.takenAt)}`
                  : t`Proof photo, ${fmt.day(p.takenAt)}`
              }
            >
              <span className="grid aspect-[4/3] w-28 place-items-center overflow-hidden rounded-[10px] border border-line bg-sunken text-ink-3">
                {p.thumbUrl ? (
                  <img src={p.thumbUrl} alt="" className="size-full object-cover" />
                ) : (
                  <CameraIcon className="size-6" />
                )}
              </span>
              {readingOf(p) ? (
                <span className="font-medium text-small text-ink tabular-nums">{readingOf(p)}</span>
              ) : null}
              <span className="text-[12px] text-ink-2">{fmt.day(p.takenAt)}</span>
            </button>
          </li>
        ))}
        {q.hasNextPage ? (
          <li className="grid shrink-0 place-items-center">
            <Button
              size="small"
              variant="secondary"
              isPending={q.isFetchingNextPage}
              onPress={() => void q.fetchNextPage()}
            >
              <Trans>Older</Trans>
            </Button>
          </li>
        ) : null}
      </ul>
      <ProofViewer
        items={items}
        index={open}
        unit={unit}
        onIndex={setOpen}
        onClose={() => setOpen(null)}
      />
    </Section>
  );
}

function ProofViewer({
  items,
  index,
  unit,
  onIndex,
  onClose,
}: {
  items: ProofItem[];
  index: number | null;
  unit: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const { thing } = useThingCtx();
  const p = index !== null ? items[index] : undefined;
  const url = useQuery({
    queryKey: ['files', 'display', p?.fileId ?? '', thing.id],
    queryFn: () => inventoryApi.fileUrl(p?.fileId ?? '', 'display', thing.id),
    enabled: !!p,
    staleTime: 4 * 60_000,
  });
  const value = p?.value ? `${fmt.num(Number(p.value))} ${unitOf(unit)}` : null;
  return (
    <Sheet
      isOpen={!!p}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Proof photo`}
    >
      {p ? (
        <div className="grid gap-3">
          <div className="grid min-h-48 place-items-center overflow-hidden rounded-[10px] bg-sunken">
            {url.data ? (
              <img
                src={url.data.url}
                alt={value ? t`The dashboard reading ${value}` : t`The dashboard`}
                className="max-h-[60vh] w-full object-contain"
              />
            ) : (
              <Skeleton className="h-48 w-full" />
            )}
          </div>
          <div className="grid gap-0.5">
            {value ? <span className="font-semibold text-[18px] tabular-nums">{value}</span> : null}
            <span className="text-small text-ink-2">
              <Trans>
                {fmt.dateTime(p.takenAt)}, by <bdi>{p.by.displayName}</bdi>
              </Trans>
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <Button
              variant="secondary"
              size="small"
              isDisabled={index === null || index >= items.length - 1}
              onPress={() => index !== null && onIndex(index + 1)}
            >
              <ChevronStartIcon className="size-4" />
              <Trans>Older</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              isDisabled={!index}
              onPress={() => index !== null && onIndex(index - 1)}
            >
              <Trans>Newer</Trans>
              <ChevronEndIcon className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
