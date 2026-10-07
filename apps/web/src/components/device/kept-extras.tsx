/**
 * A kept location's thing page, offline (step-8 plan T23; D159, D181): its money as the reader's
 * role sees it and its documents, opened from the device. Precached with the offline pages
 * (components/places/offline-pages.tsx). Nothing shows for a thing whose location isn't kept, or
 * while the lock isn't on; a passkey without PRF leaves the extras locked until the PIN.
 *
 * A document opens as a Blob URL made from the decrypted bytes, revoked a minute later: never the
 * Cache API, never a file left behind.
 */
import type { SyncExtra } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DocumentIcon } from '@/components/icons';
import { List, Row, Section } from '@/components/page';
import { useFileSize } from '@/components/portability/size';
import { useRoleLabels } from '@/components/things/labels';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import type { KeptDocument } from '@/offline/extras';
import { useAppLock } from './app-lock';
import { PinSheet } from './pin-sheet';

export function KeptExtras({ thingId }: { thingId: string }) {
  const lock = useAppLock();
  const { t } = useLingui();
  const f = useFormat();
  const money = useMoney();
  const size = useFileSize();
  const roles = useRoleLabels();
  const [askPin, setAskPin] = useState(false);
  const db = lock?.db ?? null;
  const key = lock?.dataKey ?? null;
  const on = !!lock?.record;

  const kept = useQuery({
    queryKey: ['device', 'kept', thingId, key !== null],
    enabled: on && db !== null,
    gcTime: 0,
    queryFn: async (): Promise<
      { locked: true } | { locked: false; extra: SyncExtra; documents: KeptDocument[] } | null
    > => {
      if (!db) return null;
      const m = await import('@/offline/extras');
      if (!key) return (await m.isKept(db, thingId)) ? { locked: true } : null;
      const found = await m.extraOf(db, key, thingId);
      return found ? { locked: false, ...found } : null;
    },
  });

  const data = kept.data;
  if (!data) return null;
  if (data.locked) {
    return (
      <Section title={<Trans>Kept on this device</Trans>}>
        <div className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5">
          <p className="m-0 text-small text-ink-2">
            <Trans>Enter your PIN to open the prices and documents kept on this device.</Trans>
          </p>
          <div>
            <Button size="small" variant="secondary" onPress={() => setAskPin(true)}>
              <Trans>Enter PIN</Trans>
            </Button>
          </div>
        </div>
        {askPin ? (
          <PinSheet
            title={<Trans>Enter your PIN</Trans>}
            steps={[
              {
                prompt: <Trans>Kept offline is locked behind your PIN.</Trans>,
                length: lock?.record?.pinLength,
              },
            ]}
            onClose={() => setAskPin(false)}
            onDone={async ([pin]) => {
              const result = (await lock?.openExtras(pin as string)) ?? 'wrong';
              if (result === 'ok' || result === 'wiped') {
                setAskPin(false);
                return null;
              }
              return t`Wrong PIN.`;
            }}
          />
        ) : null}
      </Section>
    );
  }

  const { extra, documents } = data;
  const open = async (doc: KeptDocument) => {
    if (!db || !key) return;
    const m = await import('@/offline/extras');
    const blob = await m.documentBlob(db, key, doc.attachmentId).catch(() => null);
    if (!blob) {
      toast({ title: t`This document isn’t on this device`, tone: 'danger' });
      return;
    }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const hidden = (
    <span className="text-ink-3">
      <Trans>Hidden in this location</Trans>
    </span>
  );
  const price =
    extra.purchase?.price && extra.purchase.currency
      ? money(extra.purchase.price, extra.purchase.currency)
      : null;
  return (
    <Section title={<Trans>Kept on this device</Trans>}>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[10px] border border-line bg-surface p-3.5 text-[15px]">
        {extra.purchase ? (
          <>
            <dt className="text-ink-2">
              <Trans>Bought</Trans>
            </dt>
            <dd className="m-0">
              {extra.purchase.date ? f.day(extra.purchase.date) : null}
              {extra.purchase.date && (price || extra.moneyHidden) ? f.sep : null}
              {extra.moneyHidden ? hidden : price}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-2">
          <Trans>Current value</Trans>
        </dt>
        <dd className="m-0">
          {extra.moneyHidden
            ? hidden
            : extra.currentValue
              ? money(extra.currentValue.amount, extra.currentValue.currency)
              : t`Not recorded`}
        </dd>
      </dl>
      {documents.length > 0 ? (
        <List>
          {documents.map((doc) => (
            <li key={doc.attachmentId}>
              <Row
                leading={<DocumentIcon />}
                title={doc.title ? <bdi>{doc.title}</bdi> : roles[doc.kind]}
                subtitle={
                  doc.tooLarge
                    ? t`Too large to keep offline (${size(doc.bytes)})`
                    : `${roles[doc.kind]}${f.sep}${size(doc.bytes)}`
                }
                trailing={
                  doc.tooLarge ? null : (
                    <Button size="small" variant="secondary" onPress={() => void open(doc)}>
                      <Trans>Open</Trans>
                    </Button>
                  )
                }
              />
            </li>
          ))}
        </List>
      ) : null}
    </Section>
  );
}
