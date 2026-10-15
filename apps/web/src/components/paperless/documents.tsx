/**
 * A thing's or a place's Paperless-ngx documents (1.x, D248), in its Paperwork section: each
 * linked document's thumbnail, title, kind, type, correspondent and date as Kept last saw them,
 * with "Open in Paperless", Download (members and up), "Copy into Kept" and Unlink. The list never
 * waits for Paperless: when it can't be reached the titles still show, with a notice saying so.
 * Shown only where the location is connected, or where links remain.
 *
 * The Paperwork list's Kind filter (`f.role`) narrows these too: a link's kind is one of the
 * attachment roles.
 */
import { can, type Role } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { paperlessPaths } from '@/api/paperless/paths';
import {
  paperlessApi,
  paperlessKeys,
  usePaperlessLinks,
  usePaperlessStatus,
} from '@/api/paperless/queries';
import type { PaperlessLink, PaperlessSubject } from '@/api/paperless/types';
import { useMe } from '@/api/queries';
import { DocumentIcon, LinkIcon, TrashIcon } from '@/components/icons';
import { List, Notice, Pill, Row, useErrorText } from '@/components/page';
import { useRoleLabels } from '@/components/things/labels';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { PaperlessPicker } from './picker';
import { usePaperlessErrorWords } from './words';

/** A Paperless thumbnail through Kept's server, or the document icon when it can't load. */
export function PaperlessThumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
        <DocumentIcon className="size-5" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-12 shrink-0 rounded-lg border border-line bg-white object-cover object-top"
    />
  );
}

export function PaperlessDocuments({
  subject,
  locationId,
  role,
  name,
  kind,
  onCopied,
}: {
  subject: PaperlessSubject;
  locationId: string;
  role: Role;
  /** The thing's or place's name, for the picker's title and the confirmations. */
  name: string;
  /** The Paperwork list's Kind filter, when one is chosen. */
  kind?: string | undefined;
  /** After "Copy into Kept": the page refetches its files. */
  onCopied?: () => void;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const links = usePaperlessLinks(subject);
  const connected = links.data?.connected ?? false;
  const status = usePaperlessStatus(locationId, connected);
  const words = usePaperlessErrorWords();
  const [picking, setPicking] = useState(false);
  const items = (links.data?.items ?? []).filter((l) => !kind || l.kind === kind);
  if (!links.data || (!connected && links.data.items.length === 0)) return null;
  const mayLink = can(role, 'attachments.add');
  const down = status.data?.reachable === false;
  return (
    <div className="grid gap-2" data-testid="paperless-documents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-semibold text-[15px]">
          <Trans>From Paperless-ngx</Trans>
        </h3>
        {mayLink && connected ? (
          <Button
            variant="secondary"
            size="small"
            isDisabled={!online}
            onPress={() => setPicking(true)}
          >
            <LinkIcon className="size-4" />
            <Trans>Link from Paperless</Trans>
          </Button>
        ) : null}
      </div>
      {down ? (
        <Notice tone="warn" title={<Trans>Paperless can't be reached</Trans>}>
          {words(status.data?.error)} <Trans>The titles below are as Kept last saw them.</Trans>
        </Notice>
      ) : null}
      {items.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          {kind ? (
            <Trans>No Paperless documents of this kind.</Trans>
          ) : (
            <Trans>
              Nothing linked yet. Link a receipt or a manual you already keep in Paperless.
            </Trans>
          )}
        </p>
      ) : (
        <List aria-label={t`Paperless documents`}>
          {items.map((l) => (
            <li key={l.id}>
              <LinkRow link={l} role={role} name={name} subject={subject} onCopied={onCopied} />
            </li>
          ))}
        </List>
      )}
      {picking ? (
        <PaperlessPicker
          locationId={locationId}
          subject={subject}
          name={name}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function LinkRow({
  link: l,
  role,
  name,
  subject,
  onCopied,
}: {
  link: PaperlessLink;
  role: Role;
  name: string;
  subject: PaperlessSubject;
  onCopied?: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const roles = useRoleLabels();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const words = usePaperlessErrorWords();
  const online = useOnline();
  const [busy, setBusy] = useState<'copy' | 'unlink' | null>(null);
  const me = useMe();
  const writer = can(role, 'attachments.add');
  const mayUnlink =
    l.createdBy.id === me.data?.user.id
      ? can(role, 'attachments.delete-own')
      : can(role, 'attachments.delete-any');
  const refresh = () => qc.invalidateQueries({ queryKey: paperlessKeys.links(subject) });
  const failure = (e: unknown) => {
    const code = isApiError(e) ? (e.details.paperlessError as string | undefined) : undefined;
    return code ? (words(code) ?? errorText(e)) : errorText(e);
  };
  const copy = async () => {
    setBusy('copy');
    try {
      await paperlessApi.copy(l.id);
      await refresh();
      onCopied?.();
      toast({ title: t`Copied into Kept`, tone: 'ok' });
    } catch (e) {
      toast({ title: t`Couldn't copy it`, description: failure(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const unlink = async () => {
    const yes = await confirm({
      title: t`Unlink this document?`,
      body: l.copiedAttachmentId
        ? t`It comes off ${name}. Paperless keeps it, and the copy in Kept stays.`
        : t`It comes off ${name}. Paperless keeps it.`,
      confirmLabel: t`Unlink`,
      destructive: true,
    });
    if (!yes) return;
    setBusy('unlink');
    try {
      await paperlessApi.unlink(l.id);
      await refresh();
    } catch (e) {
      toast({ title: t`Couldn't unlink it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const details = [
    roles[l.kind],
    l.typeName && l.typeName !== roles[l.kind] ? l.typeName : null,
    l.correspondent,
  ]
    .filter(Boolean)
    .join(fmt.sep);
  return (
    <Row
      leading={<PaperlessThumb src={paperlessPaths.linkThumb(l.id)} />}
      title={<bdi>{l.title}</bdi>}
      subtitle={
        <>
          <bdi>{details}</bdi>
          {l.createdOn ? (
            <>
              {sep()}
              {fmt.day(l.createdOn)}
            </>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
        <a
          href={l.openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClass('secondary', 'small')}
        >
          <Trans>Open in Paperless</Trans>
        </a>
        {writer ? (
          <a
            href={paperlessPaths.linkPreview(l.id)}
            className={buttonClass('ghost', 'small')}
            download
          >
            <Trans>Download</Trans>
          </a>
        ) : null}
        {l.copiedAttachmentId ? (
          <Pill tone="ok">
            <Trans>Copied into Kept</Trans>
          </Pill>
        ) : writer ? (
          <Button
            variant="ghost"
            size="small"
            isDisabled={!online}
            isPending={busy === 'copy'}
            onPress={() => void copy()}
          >
            <Trans>Copy into Kept</Trans>
          </Button>
        ) : null}
        {mayUnlink ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t`Unlink ${l.title}`}
            isDisabled={!online}
            isPending={busy === 'unlink'}
            onPress={() => void unlink()}
          >
            <TrashIcon />
          </Button>
        ) : null}
      </div>
    </Row>
  );
}
