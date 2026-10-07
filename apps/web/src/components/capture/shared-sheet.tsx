/**
 * "Shared into Kept" (D140; engineering spec §2.7; plan T23, T25). Opens on
 * `/capture?shared=<id>` with the files another app shared: RECEIPT by default for images and
 * PDFs, THING one tap away. The files wait in the offline store (pwa/share-target.ts) until they
 * are kept or discarded; closing the sheet leaves them there.
 *
 * `onKeep` turns the share into captures. It belongs to the capture pipeline (T25: target place,
 * the THING photo policy, the queue); until it is passed, the sheet offers Discard only.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { CameraIcon, DocumentIcon } from '@/components/icons';
import { List } from '@/components/page';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import type { SharedInto } from '@/offline/store';

export type SharedMode = 'receipt' | 'thing';

export function SharedSheet({
  share,
  isOpen,
  onClose,
  onDiscard,
  onKeep,
}: {
  share: SharedInto;
  isOpen: boolean;
  onClose: () => void;
  onDiscard: () => void;
  onKeep?: (mode: SharedMode) => void;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<SharedMode>('receipt');
  const count = share.files.length;
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t`Shared into Kept`}
    >
      <div className="grid gap-4">
        <p className="m-0 text-ink-2">
          <Plural value={count} one="# file arrived." other="# files arrived." />
          {share.title ? (
            <>
              {' '}
              <bdi className="text-ink">{share.title}</bdi>
            </>
          ) : null}
        </p>
        <List aria-label={t`Shared files`}>
          {share.files.map((f, i) => (
            <li
              // Two shared files can have the same name.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
              key={i}
              className="flex items-center gap-3 px-3.5 py-2.5"
            >
              {f.type === 'application/pdf' ? (
                <DocumentIcon aria-hidden="true" className="size-5 shrink-0 text-ink-2" />
              ) : (
                <CameraIcon aria-hidden="true" className="size-5 shrink-0 text-ink-2" />
              )}
              <bdi className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">
                {f.name || t`Unnamed file`}
              </bdi>
            </li>
          ))}
        </List>
        <Segmented<SharedMode>
          label={t`Keep as`}
          value={mode}
          onChange={setMode}
          options={[
            { id: 'receipt', label: <Trans>Receipt</Trans> },
            { id: 'thing', label: <Trans>Thing</Trans> },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {onKeep ? (
            <Button variant="primary" className="flex-1" onPress={() => onKeep(mode)}>
              <Trans>Keep</Trans>
            </Button>
          ) : null}
          <Button variant="secondary" className="flex-1" onPress={onDiscard}>
            <Trans>Discard</Trans>
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
