/**
 * The Paperwork section of a location's or a place's page (plan T23; D155, D172, screens §5
 * "Place fields and the location's paperwork"): the documents that belong to the whole home or a
 * room (the lease, the deed, the home insurance, the manual of a built-in oven), and the ones
 * that run out, each with Renew, which keeps the old term (D172).
 *
 * Controls follow screens §3: "Add document" for members and above (`attachments.add`), "Add
 * expiring document", Renew and Remove for those who may edit things (`things.edit`); a viewer
 * reads. Offline, adding says "Needs a connection". The section shows only while Paperwork is on
 * in the location: off, the documents rest with the module (D162).
 */
import { can, type Role } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { householdApi, householdKeys, useDocuments, usePaperwork } from '@/api/household/queries';
import type { ExpiringDocument, PaperworkRow, SubjectInput } from '@/api/household/types';
import type { AttachmentSubject } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { ClockIcon, DocumentIcon } from '@/components/icons';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import { List, Pill, Row, Section, useErrorText } from '@/components/page';
import { FileOpenButton } from '@/components/paperwork/rows';
import { useRoleLabels } from '@/components/things/labels';
import { UploadButton } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { AddDocumentSheet, RenewSheet, useInvalidateDocuments } from './document-sheets';
import { DOCUMENT_TONE, noonOf, useDocumentKindLabels, useDocumentName } from './labels';

export type PaperworkSubject =
  | { type: 'location'; locationId: string; name: string }
  | { type: 'place'; locationId: string; placeId: string; name: string };

export function SubjectPaperwork({
  subject,
  role,
  onChanged,
}: {
  subject: PaperworkSubject;
  role: Role;
  /** After a file is added: the page's own refetch (a place's attachments). */
  onChanged?: () => void;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<ExpiringDocument | null>(null);
  const id = subject.type === 'place' ? subject.placeId : subject.locationId;
  const docs = useDocuments({ locationId: subject.locationId, subjectType: subject.type });
  const files = usePaperwork({ locationId: subject.locationId, subjectType: subject.type });
  const mine = (s: { type: string; id: string }) => s.type === subject.type && s.id === id;
  const documents = (docs.data?.pages.flatMap((p) => p.items) ?? []).filter((d) => mine(d.subject));
  // An expiring document's own files show on its row, not twice.
  const plain = (files.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (r) => mine(r.subject) && !r.expiring,
  );
  const more = !!docs.hasNextPage || !!files.hasNextPage;
  const canAddFile = can(role, 'attachments.add');
  const canEdit = can(role, 'things.edit');
  const original = role !== 'viewer';
  const empty = documents.length === 0 && plain.length === 0;
  if (empty && !canAddFile && !canEdit) return null;

  const upload: AttachmentSubject =
    subject.type === 'place' ? { placeId: subject.placeId } : { location: true };
  const create: SubjectInput =
    subject.type === 'place' ? { placeId: subject.placeId } : { locationId: subject.locationId };

  return (
    <Section title={<Trans>Paperwork</Trans>}>
      {canAddFile || canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {canAddFile ? (
            online ? (
              <UploadButton
                locationId={subject.locationId}
                subject={upload}
                attachAs="document"
                label={t`Add document`}
                onUploaded={() => {
                  void qc.invalidateQueries({ queryKey: householdKeys.paperwork.all });
                  onChanged?.();
                }}
              />
            ) : (
              <Button variant="secondary" isDisabled>
                <Trans>Add document</Trans>
              </Button>
            )
          ) : null}
          {canEdit ? (
            <Button variant="secondary" isDisabled={!online} onPress={() => setAdding(true)}>
              <ClockIcon className="size-4" />
              <Trans>Add expiring document</Trans>
            </Button>
          ) : null}
          {online ? null : (
            <span className="text-small text-ink-2">
              <Trans>Needs a connection</Trans>
            </span>
          )}
        </div>
      ) : null}

      {empty ? (
        <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-4 text-small text-ink-2">
          {subject.type === 'place' ? (
            <Trans>
              No documents in <bdi>{subject.name}</bdi> yet: the manual of a built-in oven, the
              boiler's certificate.
            </Trans>
          ) : (
            <Trans>
              No documents for <bdi>{subject.name}</bdi> yet: the lease or the deed, the home
              insurance, utility contracts.
            </Trans>
          )}
        </p>
      ) : (
        <List aria-label={t`Paperwork of ${subject.name}`}>
          {documents.map((d) => (
            <li key={d.id}>
              <DocumentRow
                document={d}
                canEdit={canEdit}
                original={original}
                onRenew={() => setRenewing(d)}
              />
            </li>
          ))}
          {plain.map((r) => (
            <li key={r.attachment.id}>
              <FileRow row={r} original={original} />
            </li>
          ))}
        </List>
      )}
      {more ? (
        <Link
          to="/paperwork"
          search={{ 'f.location': subject.locationId, 'f.subject': subject.type }}
          className="justify-self-start text-small font-semibold text-ink-2 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>All of it in Paperwork</Trans>
        </Link>
      ) : null}

      <AddDocumentSheet
        isOpen={adding}
        onClose={() => setAdding(false)}
        subject={create}
        subjectName={subject.name}
      />
      <RenewSheet target={renewing} onClose={() => setRenewing(null)} />
    </Section>
  );
}

function DocumentRow({
  document: d,
  canEdit,
  original,
  onRenew,
}: {
  document: ExpiringDocument;
  canEdit: boolean;
  original: boolean;
  onRenew: () => void;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const kinds = useDocumentKindLabels();
  const nameOf = useDocumentName();
  const confirm = useConfirm();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const invalidate = useInvalidateDocuments();
  const online = useOnline();
  const name = nameOf(d);
  const day = f.day(noonOf(d.expiresOn));
  const earlier = d.history.length;

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove ${name}?`,
      body: t`Its reminders stop. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteDocument(d.id, d.rowVersion);
      await invalidate();
      offerUndo({ title: t`Removed ${name}` }, auditEvents);
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <Row
      className="flex-wrap"
      leading={
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2 [&_svg]:size-5">
          <ClockIcon />
        </span>
      }
      title={<bdi>{name}</bdi>}
      subtitle={
        <>
          {d.title ? (
            <>
              {kinds[d.kind]}
              {sep()}
            </>
          ) : null}
          {earlier > 0 ? (
            <Plural value={earlier} one="# earlier term" other="# earlier terms" />
          ) : (
            <Trans>First term</Trans>
          )}
        </>
      }
      trailing={
        canEdit ? (
          <span className="flex flex-wrap gap-2">
            <OverflowActions
              title={name}
              isDisabled={!online}
              actions={[
                { id: 'renew', label: t`Renew`, onAction: onRenew },
                { id: 'remove', label: t`Remove`, danger: true, onAction: () => void remove() },
              ]}
            />
          </span>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Pill tone={DOCUMENT_TONE[d.state]} icon={<ClockIcon />}>
          {d.state === 'expired' ? <Trans>Ran out {day}</Trans> : <Trans>Runs out {day}</Trans>}
        </Pill>
        {d.documents.map((a, i) => (
          <FileOpenButton
            key={a.id}
            attachment={a}
            original={original}
            variant="ghost"
            what={t`${name}, file ${f.num(i + 1)}`}
          >
            {d.documents.length > 1 ? <Trans>File {f.num(i + 1)}</Trans> : undefined}
          </FileOpenButton>
        ))}
      </div>
    </Row>
  );
}

function FileRow({ row, original }: { row: PaperworkRow; original: boolean }) {
  const roles = useRoleLabels();
  const a = row.attachment;
  const title = roles[a.role];
  return (
    <Row
      leading={
        a.file?.thumbUrl ? (
          <img src={a.file.thumbUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2 [&_svg]:size-5">
            <DocumentIcon />
          </span>
        )
      }
      title={title}
      subtitle={<bdi>{a.createdBy.displayName}</bdi>}
      trailing={<FileOpenButton attachment={a} original={original} what={title} />}
    />
  );
}
