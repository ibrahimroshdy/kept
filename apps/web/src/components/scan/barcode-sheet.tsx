/**
 * A product barcode (D104, D126, D137 case 4; plan T26, Q22). When the server's lookup is on, one
 * `GET /barcodes/:code` names the product (Open Food Facts and its sister databases, with their
 * ODbL attribution shown); nothing about it is stored on the server, and no product image is ever
 * fetched. Found or not, "Add as a new thing" queues a THING capture with the barcode kept and the
 * name filled in, which the person can change; it works offline, where the lookup can't run.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { Form } from 'react-aria-components';
import { useBarcode } from '@/api/capture/queries';
import { rememberTarget } from '@/components/capture/target';
import { Notice } from '@/components/page';
import type { PickedPlace } from '@/components/places/move-picker';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { AgainOrDone, AnswerFrame, type AnswerProps } from './outcome-sheet';
import { queueItem } from './resolve';
import { WherePicker } from './where-picker';

/** "Stabilo Textmarker": the brand first, unless the product's name already starts with it. */
export function productName(p: { name: string | null; brand: string | null }): string {
  const name = p.name?.trim() ?? '';
  const brand = p.brand?.trim() ?? '';
  if (!brand) return name;
  if (!name) return brand;
  return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
}

export function BarcodeSheet({
  code,
  lookupEnabled,
  store,
  online,
  onCamera,
  onAgain,
  onDone,
  onQueued,
}: AnswerProps & { code: string; lookupEnabled: boolean | null }) {
  const { t } = useLingui();
  const lookup = useBarcode(online && lookupEnabled ? code : null);
  const found = lookup.data?.enabled && lookup.data.found ? lookup.data : null;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [place, setPlace] = useState<PickedPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = useCallback((p: PickedPlace) => setPlace(p), []);

  // The product's name, once, as the starting point.
  const suggested = found?.product ? productName(found.product) : '';
  useEffect(() => {
    if (suggested) setName((n) => n || suggested);
  }, [suggested]);

  const add = async () => {
    if (!store || !place) return;
    setBusy(true);
    try {
      const id = newId();
      const typed = name.trim().slice(0, 200);
      await store.enqueue(
        queueItem(
          'create_thing',
          place.locationId,
          {
            id,
            target: { placeId: place.placeId },
            mode: 'thing',
            batchId: newId(),
            files: [],
            barcode: code.slice(0, 64),
            ...(typed ? { name: typed } : {}),
          },
          { key: `cap:${id}` },
        ),
        [],
      );
      rememberTarget({ locationId: place.locationId, placeId: place.placeId, containerId: null });
      onQueued?.();
      toast({
        title: typed ? t`Added ${typed}` : t`Added a new thing`,
        description: t`Its ID arrives when it syncs.`,
        tone: 'ok',
      });
      onAgain();
    } finally {
      setBusy(false);
    }
  };

  const status =
    lookupEnabled === null || !online ? (
      <Trans>Looking it up needs a connection.</Trans>
    ) : !lookupEnabled ? null : lookup.isPending ? (
      <Trans>Looking it up…</Trans>
    ) : lookup.data?.enabled && !lookup.data.found ? (
      <Trans>Not found in the product databases.</Trans>
    ) : lookup.isError ? (
      <Trans>The lookup didn't answer. You can still add it.</Trans>
    ) : null;

  return (
    <AnswerFrame label={t`Scan result`} onCamera={onCamera}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-small text-ink-3">
          <Trans>Product barcode</Trans>
        </span>
        <bdi dir="ltr" className="font-mono text-small text-ink">
          {code}
        </bdi>
      </div>
      {found?.product ? (
        <div className="grid gap-0.5">
          <h2 className="m-0 font-semibold text-[19px] [overflow-wrap:anywhere]">
            <bdi>{productName(found.product) || t`A product`}</bdi>
          </h2>
          {found.product.quantity ? (
            <bdi className="text-small text-ink-3">{found.product.quantity}</bdi>
          ) : null}
          <span className="text-[12.5px] text-ink-3">
            <Trans>From {found.attribution}</Trans>
          </span>
        </div>
      ) : (
        <h2 className="m-0 font-semibold text-[19px]">
          <Trans>A product barcode</Trans>
        </h2>
      )}
      {status ? <p className="m-0 text-small text-ink-3">{status}</p> : null}

      {adding ? (
        <Form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label={t`Name`}
            description={t`Optional: without one it waits in the Inbox to be named.`}
            value={name}
            onChange={setName}
            maxLength={200}
          />
          <WherePicker store={store} label={t`Where it is`} value={place} onChange={pick} />
          {!store ? (
            <Notice tone="info">
              <Trans>Opening this phone's copy of your Kept…</Trans>
            </Notice>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onPress={() => setAdding(false)}>
              <Trans>Back</Trans>
            </Button>
            <Button type="submit" isPending={busy} isDisabled={!store || !place}>
              <Trans>Add</Trans>
            </Button>
          </div>
        </Form>
      ) : (
        <>
          <p className="m-0 text-ink-2">
            <Trans>Kept stores the barcode with it.</Trans>
          </p>
          <Button onPress={() => setAdding(true)}>
            <Trans>Add as a new thing</Trans>
          </Button>
          <AgainOrDone onAgain={onAgain} onDone={onDone} />
        </>
      )}
    </AnswerFrame>
  );
}
