/**
 * Where and when it was bought (task 12, from `kept.thing_purchase`). Money follows the gate:
 * the server leaves the price out for a viewer when the location hides money from viewers (D13),
 * and for everyone when the Money module is off, and says so with `moneyHidden` (the receipts go
 * with it: a receipt shows the price). Date and shop show either way.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AttachmentView } from '@/api/inventory/types';
import { DocumentIcon, ShareIcon } from '@/components/icons';
import { Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useThingCtx } from './context';
import { type OriginalHandle, useOriginalFile } from './original-file';
import { Bidi, KeyValues, KV, useMoney } from './values';

export function PurchaseSection() {
  const { thing, moduleOn } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const p = thing.purchase;
  if (!p) return null;
  const price = p.unitPrice && p.currency ? money(p.unitPrice, p.currency) : null;
  return (
    <Section title={<Trans>Purchase</Trans>}>
      <KeyValues label={t`Purchase`}>
        {p.purchasedOn ? <KV label={t`Bought`}>{fmt.day(p.purchasedOn)}</KV> : null}
        {p.vendor ? (
          <KV label={t`From`}>
            <Bidi>{p.vendor.name}</Bidi>
          </KV>
        ) : null}
        {p.lineDescription ? (
          <KV label={t`On the receipt`}>
            <Bidi>{p.lineDescription}</Bidi>
          </KV>
        ) : null}
        {moduleOn('money') ? (
          <KV label={t`Price`}>
            {price ? (
              p.quantity && p.quantity > 1 ? (
                <Trans>
                  {fmt.num(p.quantity)} × {price}
                </Trans>
              ) : (
                price
              )
            ) : p.moneyHidden || thing.moneyHidden ? (
              <span className="text-ink-3">
                <Trans>Not shown to viewers here</Trans>
              </span>
            ) : (
              <span className="text-ink-3">
                <Trans>Not recorded</Trans>
              </span>
            )}
          </KV>
        ) : null}
      </KeyValues>
      {p.receipts.length ? <Receipts receipts={p.receipts} /> : null}
    </Section>
  );
}

/**
 * Pressing an attachment (D157): a link opens; a file opens through a short-lived signed URL,
 * its original for someone who may add attachments, else its inline display or thumb; a receipt
 * after a move uses ?thingId. On the installed iPhone app an original is shared instead
 * (original-file.ts).
 */
export function useAttachmentFile(a: AttachmentView): OriginalHandle {
  const { thing, can } = useThingCtx();
  const variant = can('attachments.add') ? 'original' : a.file?.displayUrl ? 'display' : 'thumb';
  const handle = useOriginalFile(
    a.file && !a.url
      ? { fileId: a.file.id, mime: a.file.mime, role: a.role, thingId: thing.id, variant }
      : null,
  );
  if (a.url) {
    const url = a.url;
    return { mode: 'open', pending: false, press: () => window.open(url, '_blank', 'noopener') };
  }
  return handle;
}

function Receipts({ receipts }: { receipts: AttachmentView[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {receipts.map((r, i) => (
        <li key={r.id}>
          <ReceiptButton receipt={r} n={i + 1} />
        </li>
      ))}
    </ul>
  );
}

function ReceiptButton({ receipt, n }: { receipt: AttachmentView; n: number }) {
  const file = useAttachmentFile(receipt);
  const fmt = useFormat();
  return (
    <Button
      ref={file.ref}
      variant="secondary"
      size="small"
      isPending={file.pending}
      onPress={file.press}
    >
      {file.mode === 'share' ? (
        <ShareIcon className="size-4" />
      ) : (
        <DocumentIcon className="size-4" />
      )}
      <Trans>Receipt {fmt.num(n)}</Trans>
    </Button>
  );
}
