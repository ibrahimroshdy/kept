/**
 * Paperwork: the thing's attachments by role (task 17), under the list standard with the role
 * as a filter in the URL (`f.role`), under the thing's warranties and their coverage bars (step 4,
 * T20: components/warranties).
 * Originals open only for members and above (D117); viewers get the display copy.
 */
import { ATTACHMENT_ROLES } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { thingApi, useInvalidateThing, useThingAttachments } from '@/api/inventory/thing-api';
import type { AttachmentRole, AttachmentView } from '@/api/inventory/types';
import { DocumentIcon, ShareIcon, TrashIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Row, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { firstOf, useListState } from '@/lib/url-state';
import { useThingCtx } from './context';
import { WarrantiesBlock } from './household-lazy';
import { useRoleLabels } from './labels';
import { useAttachmentFile } from './purchase-section';
import { UploadButton } from './upload';

export function PaperworkSection() {
  const { thing, can, moduleOn } = useThingCtx();
  const { t } = useLingui();
  const roles = useRoleLabels();
  const [list] = useListState();
  const role = firstOf(list, 'role');
  const query = useThingAttachments(thing.id, role);
  const invalidate = useInvalidateThing();
  const [uploadRole, setUploadRole] = useState<AttachmentRole>('document');
  return (
    <Section
      title={
        moduleOn('warranties') ? <Trans>Paperwork and warranties</Trans> : <Trans>Paperwork</Trans>
      }
    >
      <WarrantiesBlock />
      {can('attachments.add') ? (
        <div className="grid items-end gap-2 rounded-[10px] border border-line bg-surface p-3 md:grid-cols-[minmax(0,16rem)_auto]">
          <Combobox
            label={t`Add as`}
            items={ATTACHMENT_ROLES.map((r) => ({ id: r, label: roles[r] }))}
            selectedKey={uploadRole}
            onSelectionChange={(k) => {
              if (k) setUploadRole(String(k) as AttachmentRole);
            }}
          />
          <UploadButton
            locationId={thing.locationId}
            subject={{ thingId: thing.id }}
            attachAs={uploadRole}
            label={t`Add a file`}
            onUploaded={() => void invalidate(thing.id)}
          />
        </div>
      ) : null}
      <ListSurface<AttachmentView>
        label={t`Paperwork`}
        search={false}
        filters={
          // Kind chips once there is something to narrow (or a kind is already chosen).
          (query.data?.pages[0]?.items.length ?? 0) === 0 && !role
            ? []
            : [
                {
                  key: 'role',
                  label: t`Kind`,
                  kind: 'single',
                  values: {
                    from: 'static',
                    options: ATTACHMENT_ROLES.filter((r) => r !== 'photo').map((r) => ({
                      value: r,
                      label: roles[r],
                    })),
                  },
                },
              ]
        }
        query={query}
        getKey={(a) => a.id}
        renderRow={(a) => <AttachmentRow attachment={a} />}
        empty={
          <EmptyState icon={<DocumentIcon />} title={<Trans>No paperwork yet</Trans>}>
            <Trans>Receipts, manuals and warranty cards live here, as the originals.</Trans>
          </EmptyState>
        }
      />
    </Section>
  );
}

function AttachmentRow({ attachment: a }: { attachment: AttachmentView }) {
  const { thing, can, me } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const roles = useRoleLabels();
  const file = useAttachmentFile(a);
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateThing();
  const mayDelete =
    a.createdBy.displayName === me ? can('attachments.delete-own') : can('attachments.delete-any');
  const size = a.file ? `${fmt.num(Math.max(1, Math.round(a.file.bytes / 1024)))} KB` : null;
  return (
    <Row
      leading={
        a.file?.thumbUrl ? (
          <img src={a.file.thumbUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
            <DocumentIcon className="size-5" />
          </span>
        )
      }
      title={roles[a.role]}
      subtitle={
        <>
          {a.file?.derivativeState === 'unavailable' ? (
            <>
              <Trans>Preview unavailable</Trans>
              {sep()}
            </>
          ) : null}
          {size ? (
            <>
              {size}
              {sep()}
            </>
          ) : null}
          <bdi>{a.createdBy.displayName}</bdi>
        </>
      }
      trailing={
        <span className="flex gap-1">
          <Button variant="secondary" size="small" isPending={file.pending} onPress={file.press}>
            {file.mode === 'share' ? (
              <>
                <ShareIcon className="size-4" />
                <Trans>Share</Trans>
              </>
            ) : (
              <Trans>Open</Trans>
            )}
          </Button>
          {mayDelete ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Remove this ${roles[a.role]}`}
              onPress={async () => {
                if (
                  !(await confirm({
                    title: t`Remove this ${roles[a.role]}?`,
                    body: t`It comes off ${thing.name ?? ''}. The file itself stays until it's purged.`,
                    confirmLabel: t`Remove`,
                    destructive: true,
                  }))
                )
                  return;
                try {
                  await thingApi.deleteAttachment(a.id);
                  await invalidate(thing.id);
                } catch (e) {
                  toast({
                    title: t`Couldn't remove it`,
                    description: errorText(e),
                    tone: 'danger',
                  });
                }
              }}
            >
              <TrashIcon />
            </Button>
          ) : null}
        </span>
      }
    />
  );
}
