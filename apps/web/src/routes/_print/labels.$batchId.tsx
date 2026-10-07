/**
 * A label batch as print-styled sheets (plan T28; D44, D97, D185): no app shell, one sheet per
 * page at the stock's `@page` size, and a screen-only bar with Print and "Share as images" (one
 * PNG per label, made on the phone, for label-printer apps). Where the browser shares files the
 * PNGs are made as the page opens, so the press opens the share sheet at once: iOS refuses a
 * share that waited on them, and an installed iPhone app can't download them instead
 * (lib/files.ts). Print opens the browser's dialog,
 * then "Printed OK?" records the print date (screens §6). Arriving from the builder (`?print=1`)
 * opens the dialog by itself once the QR encoder and the fonts are ready; a reload doesn't.
 *
 * Reprinting a batch prints the same codes (D45). `?stock=` and `?start=` print it on another
 * stock or from another cell without changing the batch.
 */
import { isSheet, LABEL_STOCKS, labelStock } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useLabelBatch } from '@/api/capture/queries';
import { ChevronStartIcon, PrinterIcon, ShareIcon } from '@/components/icons';
import { perPage } from '@/components/labels/layout';
import { labelPngs, shareOrDownload } from '@/components/labels/png';
import { PrintedOkDialog } from '@/components/labels/printed-ok';
import { useQrEncoder } from '@/components/labels/qr';
import { LabelSheets } from '@/components/labels/sheet';
import { useStockText } from '@/components/labels/stock-picker';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { canShareType } from '@/lib/files';
import { useFormat } from '@/lib/format';

type PrintSearch = { print?: 1; stock?: string; start?: number };

export const Route = createFileRoute('/_print/labels/$batchId')({
  validateSearch: (s: Record<string, unknown>): PrintSearch => {
    const out: PrintSearch = {};
    if (s.print === 1 || s.print === '1') out.print = 1;
    if (typeof s.stock === 'string' && LABEL_STOCKS.some((x) => x.key === s.stock))
      out.stock = s.stock;
    const start = Number(s.start);
    if (Number.isInteger(start) && start > 0) out.start = start;
    return out;
  },
  component: PrintLabelsPage,
});

function PrintLabelsPage() {
  const { t } = useLingui();
  const { batchId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const fmt = useFormat();
  const errorText = useErrorText();
  const stockText = useStockText();
  const batch = useLabelBatch(batchId);
  const encode = useQrEncoder();
  const [asking, setAsking] = useState(false);
  const autoPrinted = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const data = batch.data;
  const stockKey =
    search.stock ??
    (data && LABEL_STOCKS.some((s) => s.key === data.stock) ? data.stock : 'a4_24_70x37');
  const stock = labelStock(stockKey);
  const startCell = isSheet(stock)
    ? Math.min(search.start ?? (search.stock ? 1 : (data?.startCell ?? 1)), perPage(stock))
    : 1;

  const print = () => {
    window.print();
    // print() returns once the dialog closes (or at once, on iOS): then ask.
    setAsking(true);
  };

  // From the builder: open the dialog once, when the QR and the faces are ready.
  useEffect(() => {
    if (!search.print || !data || !encode || autoPrinted.current) return;
    autoPrinted.current = true;
    void navigate({
      to: '/labels/$batchId',
      params: { batchId },
      search: (prev) => ({ ...prev, print: undefined }),
      replace: true,
    });
    void (async () => {
      await document.fonts?.ready;
      print();
    })();
  });

  // Where the share sheet takes PNGs, they're made ahead, so a press shares in its own turn.
  const [shareable] = useState(() => canShareType('kept-label.png', 'image/png'));
  const prepared = useQuery({
    queryKey: ['labels', 'pngs', batchId, stock.key, batch.dataUpdatedAt],
    queryFn: () => labelPngs(stock, data?.labels ?? []),
    enabled: shareable && !!data && data.labels.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const [sharing, setSharing] = useState(false);
  const shareImages = async () => {
    setSharing(true);
    try {
      const files = prepared.data ?? (await labelPngs(stock, data?.labels ?? []));
      const how = await shareOrDownload(files, t`Kept labels`);
      if (how === 'downloaded') toast({ title: t`Saved the label images`, tone: 'ok' });
      if (how === 'refused')
        toast({ title: t`Couldn't share the label images. Try again.`, tone: 'danger' });
    } catch (e) {
      toast({ title: errorText(e), tone: 'danger' });
    } finally {
      setSharing(false);
    }
  };

  if (batch.isPending) return <LoadingRows />;
  if (batch.isError || !data)
    return (
      <div className="mx-auto max-w-lg p-4">
        <ErrorState error={batch.error} onRetry={() => batch.refetch()} />
      </div>
    );

  const count = data.labels.length;
  const title =
    data.kind === 'blank'
      ? plural(count, { one: '# blank label', other: '# blank labels' })
      : plural(count, { one: '# label', other: '# labels' });
  const stockTitle = stockText(stock).title;
  const printedOn = data.printedConfirmedAt ? fmt.day(data.printedConfirmedAt) : null;

  return (
    <>
      <header className="sticky top-0 z-20 grid gap-2 border-b border-line bg-paper px-3 py-2 print:hidden md:px-6">
        {/* Phones: the title and its stock full width, the actions on their own row below
            (Print first, the primary), so the title is never squeezed into a column beside two
            buttons. From md: one row, the actions at the end with Print last. */}
        <div className="grid gap-2 md:flex md:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Link
              to="/labels"
              aria-label={t`Back to labels`}
              className="grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
            >
              <ChevronStartIcon />
            </Link>
            <div className="grid min-w-0 flex-1">
              <h1 ref={titleRef} className="m-0 font-semibold text-title text-ink">
                {title}
              </h1>
              <span className="text-small text-ink-2">{stockTitle}</span>
            </div>
          </div>
          <div
            data-slot="label-actions"
            className="grid grid-cols-2 gap-2 md:flex md:shrink-0 md:flex-row-reverse"
          >
            <Button onPress={print} isDisabled={count === 0 || !encode}>
              <PrinterIcon className="size-5" />
              <Trans>Print</Trans>
            </Button>
            <Button
              variant="secondary"
              onPress={() => void shareImages()}
              isPending={sharing || prepared.isFetching}
              isDisabled={count === 0}
            >
              <ShareIcon className="size-5" />
              <Trans>Share as images</Trans>
            </Button>
          </div>
        </div>
        {printedOn ? (
          <Notice tone="ok">
            <Trans>Printed on {printedOn}. Reprinting prints the same codes.</Trans>
          </Notice>
        ) : null}
        <p className="m-0 text-small text-ink-2">
          {isSheet(stock) ? (
            <Trans>
              In the print dialog choose {stockTitle}, scale 100% and no margins, so each label
              lands in its cell.
            </Trans>
          ) : (
            <Trans>In the print dialog choose your label printer and this label size.</Trans>
          )}
        </p>
      </header>
      <LabelSheets stock={stock} labels={data.labels} startCell={startCell} encode={encode} />
      <PrintedOkDialog
        batch={data}
        isOpen={asking}
        onClose={() => setAsking(false)}
        hintAnchor={titleRef}
      />
    </>
  );
}
