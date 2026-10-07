/**
 * The batch builder (plan T28; D43, D137, D175; screens §6 "Label printing"): what is printing,
 * the stock, the start cell on a partly used sheet, then Print.
 *
 * What prints comes from where the person started: a selection of things, a place's own label,
 * "Label everything unprinted" in a place or location, or a blank sheet. The list is the server's
 * answer to a dry run (`dryRun`, nothing saved or allocated), so it shows exactly what the batch
 * will hold, and says how many things were left out because their ID is still pending (they were
 * captured offline and haven't synced). Print makes the batch, then opens the print view, which
 * opens the print dialog.
 */
import { isSheet, labelStock } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { captureApi, captureKeys, useLabelSummary } from '@/api/capture/queries';
import type {
  CreateLabelBatchBody,
  LabelBatchKind,
  LabelBatchNothingDetails,
  LabelCellContent,
  LabelExclusions,
} from '@/api/capture/types';
import { isApiError } from '@/api/client';
import type { LocationDetail } from '@/api/types';
import { PrinterIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { EmptyState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { LabelCell } from './label-cell';
import { perPage } from './layout';
import { useQrEncoder } from './qr';
import { StartCellPicker } from './start-cell';
import { rememberedStock, StockPicker, useStockText } from './stock-picker';

/** Where the builder was opened from (the `/labels` search). */
export type BatchSource = {
  locationId: string;
  kind: LabelBatchKind;
  thingIds?: string[];
  placeIds?: string[];
  /** "Label everything unprinted", in a place's subtree or the whole location. */
  unprinted?: { placeId?: string };
  blankCount?: number;
};

/** Shown on a roll's preview before a blank label has its code. */
const SAMPLE: LabelCellContent = { code: '000000', url: '/l/000000', kind: 'blank' };

/**
 * The server's 400 for a real batch with nothing left to label (T16): what it left out, or null
 * when the error is something else.
 */
export function nothingToLabel(e: unknown): LabelExclusions | null {
  if (!isApiError(e) || e.code !== 'validation') return null;
  const x = (e.details as Partial<LabelBatchNothingDetails>).excluded;
  return x && typeof x.pending === 'number' && typeof x.other === 'number' ? x : null;
}

/** "Nothing here can be labelled now", and why, in counts. */
function NothingToLabel({ excluded }: { excluded: LabelExclusions }) {
  const { t } = useLingui();
  const { pending, other } = excluded;
  const lines = [
    ...(pending > 0
      ? [
          plural(pending, {
            one: '# is waiting to sync: its ID is still pending.',
            other: '# are waiting to sync: their IDs are still pending.',
          }),
        ]
      : []),
    ...(other > 0
      ? [
          plural(other, {
            one: "# can't be labelled here: it is in the trash or in another location.",
            other: "# can't be labelled here: they are in the trash or in another location.",
          }),
        ]
      : []),
  ];
  return (
    <Notice tone="warn" title={t`Nothing here can be labelled now`}>
      {lines.length ? (
        lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))
      ) : (
        <Trans>Everything listed has been printed since.</Trans>
      )}
    </Notice>
  );
}

/** A blank sheet at most (D172 caps unclaimed labels at 1,000 per location; a batch at 500). */
export const MAX_BLANK = 500;

export function BatchBuilder({
  source,
  location,
}: {
  source: BatchSource;
  location: LocationDetail;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const stockText = useStockText();
  const encode = useQrEncoder();
  const [stockKey, setStockKey] = useState(rememberedStock);
  const stock = labelStock(stockKey);
  const sheet = isSheet(stock);
  const [start, setStart] = useState(1);
  const startCell = sheet ? Math.min(start, perPage(stock)) : 1;
  const [blankCount, setBlankCount] = useState(() => {
    const first = labelStock(rememberedStock());
    return Math.min(MAX_BLANK, source.blankCount ?? (isSheet(first) ? perPage(first) : 10));
  });
  const blank = source.kind === 'blank';
  const summary = useLabelSummary(location.id);
  const unclaimed = summary.data?.blankUnclaimed ?? 0;

  const body: CreateLabelBatchBody = {
    locationId: location.id,
    kind: source.kind,
    ...(source.thingIds ? { thingIds: source.thingIds } : {}),
    ...(source.placeIds ? { placeIds: source.placeIds } : {}),
    ...(source.unprinted ? { unprinted: source.unprinted } : {}),
    ...(blank ? { blankCount } : {}),
    stock: stockKey,
    startCell,
  };
  const preview = useQuery({
    // The stock and start cell don't change what prints.
    queryKey: [...captureKeys.labels.all, 'preview', { ...body, stock: null, startCell: null }],
    queryFn: () => captureApi.previewLabelBatch(body),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const labels = preview.data?.labels ?? [];
  const count = blank ? blankCount : labels.length;
  const pending = preview.data?.excluded.pending ?? 0;

  const create = useMutation({
    mutationFn: () => captureApi.createLabelBatch(body),
    // The list changed under the preview (printed, trashed or pending since): show it as it is.
    onError: (e) => {
      if (nothingToLabel(e)) void preview.refetch();
    },
    onSuccess: async ({ batch }) => {
      qc.setQueryData(captureKeys.labels.batch(batch.id), batch);
      void qc.invalidateQueries({ queryKey: captureKeys.labels.all });
      await navigate({
        to: '/labels/$batchId',
        params: { batchId: batch.id },
        search: { print: 1 },
      });
    },
  });

  const nothingLeft = nothingToLabel(create.error);
  const first = labels[0];
  const { title: stockTitle } = stockText(stock);
  const countText = fmt.num(count);
  const pendingText = plural(pending, {
    one: '# thing was left out: its ID is still pending.',
    other: '# things were left out: their IDs are still pending.',
  });

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,380px)] md:items-start md:gap-7">
      <div className="grid min-w-0 content-start gap-5">
        {blank ? (
          <BlankCount
            value={blankCount}
            onChange={setBlankCount}
            max={Math.max(1, Math.min(MAX_BLANK, 1000 - unclaimed))}
            unclaimed={unclaimed}
          />
        ) : (
          <section className="grid gap-2">
            <h2 className="eyebrow m-0">
              <Trans>Printing {countText}</Trans>
            </h2>
            {preview.isPending ? (
              <LoadingRows rows={2} />
            ) : labels.length === 0 && !preview.isError ? (
              <EmptyState icon={<PrinterIcon />} title={t`Nothing to print`}>
                {source.unprinted ? (
                  <Trans>Everything here already has a printed label.</Trans>
                ) : (
                  <Trans>None of these has an ID yet.</Trans>
                )}
              </EmptyState>
            ) : (
              <ul className="m-0 grid list-none gap-0 overflow-hidden rounded-[10px] border border-line bg-surface p-0 sm:grid-cols-2">
                {labels.map((l) => (
                  <li
                    key={l.code}
                    className="flex min-w-0 items-center gap-2.5 border-line px-3 py-2 not-first:border-t sm:nth-2:border-t-0 sm:even:border-s"
                  >
                    <IdChip code={l.code} />
                    <bdi className="min-w-0 text-small text-ink-2 [overflow-wrap:anywhere]">
                      {l.name ?? ''}
                    </bdi>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {pending > 0 ? (
          <Notice title={pendingText}>
            <Trans>
              They get their IDs when the phone that captured them syncs. Print them then, from
              "Print pending labels" on that phone.
            </Trans>
          </Notice>
        ) : null}
        {preview.isError ? <Notice tone="danger">{errorText(preview.error)}</Notice> : null}

        <StockPicker
          value={stockKey}
          onChange={(key) => {
            setStockKey(key);
            setStart(1);
          }}
        />

        {create.isError ? (
          nothingLeft ? (
            <NothingToLabel excluded={nothingLeft} />
          ) : (
            <Notice tone="danger">{errorText(create.error)}</Notice>
          )
        ) : null}
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              onPress={() => create.mutate()}
              isPending={create.isPending}
              isDisabled={count === 0 || preview.isError || preview.isPending}
            >
              <PrinterIcon className="size-5" />
              {plural(count, { one: 'Print # label', other: 'Print # labels' })}
            </Button>
            <Link
              to="/labels"
              className="inline-flex min-h-11 items-center rounded-[10px] px-3 font-semibold text-ink underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
            >
              <Trans>Back</Trans>
            </Link>
          </div>
          <p className="m-0 text-small text-ink-2">
            {sheet ? (
              <Trans>
                Opens the print dialog at {stockTitle}, scale 100%. Afterwards Kept asks "Printed
                OK?" and records the print date.
              </Trans>
            ) : (
              <Trans>
                Opens the print dialog: choose your label printer and this label size. Afterwards
                Kept asks "Printed OK?" and records the print date.
              </Trans>
            )}
          </p>
        </div>
      </div>

      <div className="grid min-w-0 content-start gap-2">
        {sheet ? (
          <StartCellPicker
            stock={stock}
            value={startCell}
            onChange={setStart}
            labels={labels}
            count={count}
          />
        ) : (
          <>
            <span className="eyebrow">
              <Trans>Label preview</Trans>
            </span>
            <div className="justify-self-center overflow-hidden rounded-md border border-line shadow-[0_8px_24px_rgba(0,0,0,.1)]">
              <div
                // Printed size, zoomed to about 260 px wide.
                style={{ zoom: 260 / ((stock.cell.w * 96) / 25.4) }}
              >
                <div style={{ inlineSize: `${stock.cell.w}mm`, blockSize: `${stock.cell.h}mm` }}>
                  <LabelCell label={first ?? SAMPLE} stock={stock} encode={encode} />
                </div>
              </div>
            </div>
            {blank ? (
              <p className="m-0 text-small text-ink-2">
                <Trans>Each blank label gets its own code when you print.</Trans>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** "How many blank labels": a stepper, never an OS number picker. */
function BlankCount({
  value,
  onChange,
  max,
  unclaimed,
}: {
  value: number;
  onChange: (n: number) => void;
  max: number;
  unclaimed: number;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const n = fmt.num(value);
  const left = fmt.num(unclaimed);
  const cap = fmt.num(1000);
  const set = (next: number) => onChange(Math.max(1, Math.min(max, next)));
  return (
    <section className="grid gap-2">
      <h2 className="eyebrow m-0">
        <Trans>Blank labels</Trans>
      </h2>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          aria-label={t`Fewer`}
          isDisabled={value <= 1}
          onPress={() => set(value - (value > 10 ? 10 : 1))}
        >
          −
        </Button>
        <output
          aria-live="polite"
          className="min-w-16 text-center font-semibold text-title tabular-nums"
        >
          {n}
        </output>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t`More`}
          isDisabled={value >= max}
          onPress={() => set(value + (value >= 10 ? 10 : 1))}
        >
          +
        </Button>
      </div>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Stick them on boxes now and name them later: the first scan asks what each one is. This
          location has {left} unclaimed of at most {cap}.
        </Trans>
      </p>
    </section>
  );
}
