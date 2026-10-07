/**
 * One file in the paperwork library (plan T23; D39, D155): what it is (its role, or the expiring
 * document's kind), what it belongs to (a thing, a place or a whole location, linked), when it runs
 * out, and the line of its text that matched the search. **Open** asks for a short-lived signed URL
 * (`POST /files/:id/url`): the original for members and above, the display copy for a viewer
 * (D117); the installed iPhone app shares it. As a list row, or as a tile in the Grid layout (D211).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { PaperworkRow, SubjectRef } from '@/api/household/types';
import type { AttachmentView } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { DOCUMENT_TONE, noonOf, useDocumentKindLabels } from '@/components/documents/labels';
import { BoxIcon, ClockIcon, DocumentIcon, HomeIcon, ShareIcon } from '@/components/icons';
import { Pill } from '@/components/page';
import { useRoleLabels } from '@/components/things/labels';
import { useOriginalFile } from '@/components/things/original-file';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Open an attachment: a URL attachment as it is; a file through a signed URL, its original for
 * members and above and the display copy for a viewer (D117). On the installed iPhone app an
 * original is shared instead, fetched ahead so the press opens the share sheet in its own turn
 * (things/original-file.ts).
 */
export function FileOpenButton({
  attachment: a,
  original,
  thingId,
  what,
  className,
  variant = 'secondary',
  children,
}: {
  attachment: AttachmentView;
  /** The reader may have the original (members and above). */
  original: boolean;
  thingId?: string;
  /** What it opens, for the button's name: "Open Lease for Home", or "Share …" on the iPhone app. */
  what: string;
  className?: string;
  variant?: 'secondary' | 'ghost';
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const file = useOriginalFile(
    a.file && !a.url
      ? {
          fileId: a.file.id,
          mime: a.file.mime,
          role: a.role,
          ...(thingId ? { thingId } : {}),
          variant: original ? 'original' : a.file.displayUrl ? 'display' : 'thumb',
        }
      : null,
  );
  const url = a.url;
  if (!url && !a.file) return null;
  return (
    <Button
      ref={file.ref}
      size="small"
      variant={variant}
      className={className}
      aria-label={file.mode === 'share' ? t`Share ${what}` : t`Open ${what}`}
      isPending={file.pending}
      onPress={() => (url ? void window.open(url, '_blank', 'noopener') : file.press())}
    >
      {file.mode === 'share' ? <ShareIcon className="size-4" /> : null}
      {children ?? (file.mode === 'share' ? <Trans>Share</Trans> : <Trans>Open</Trans>)}
    </Button>
  );
}

/** Whether you may have originals where this row sits: your role in its location (D117). */
export function useMayHaveOriginal(): (subject: SubjectRef) => boolean {
  const locations = useLocations();
  const all = locations.data ?? [];
  return (subject) => {
    const here = subject.type === 'location' ? all.find((l) => l.id === subject.id) : undefined;
    // A thing's or a place's location isn't on the row: a viewer everywhere gets the display
    // copy; anyone else asks for the original, which the server still checks.
    return here ? here.role !== 'viewer' : all.some((l) => l.role !== 'viewer');
  };
}

/** Where a subject's page is: a thing, a place, or a location. */
export function SubjectLink({ subject, className }: { subject: SubjectRef; className?: string }) {
  const cls = cn(
    'font-medium text-ink underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info [overflow-wrap:anywhere]',
    className,
  );
  const name = <bdi>{subject.name}</bdi>;
  if (subject.type === 'thing')
    return (
      <Link to="/t/$id" params={{ id: subject.id }} className={cls}>
        {name}
      </Link>
    );
  if (subject.type === 'place')
    return (
      <Link to="/p/$id" params={{ id: subject.id }} className={cls}>
        {name}
      </Link>
    );
  return (
    <Link to="/loc/$id" params={{ id: subject.id }} className={cls}>
      {name}
    </Link>
  );
}

export function SubjectIcon({ type }: { type: SubjectRef['type'] }) {
  return type === 'location' ? <HomeIcon /> : <BoxIcon />;
}

/** The path under a subject's name ("Home › Kitchen"), when it adds anything. */
function Path({ subject }: { subject: SubjectRef }) {
  if (!subject.path || subject.path === subject.name) return null;
  return (
    <span className="text-ink-3">
      {sep()}
      <bdi>{subject.path}</bdi>
    </span>
  );
}

function useRowWords(row: PaperworkRow) {
  const roles = useRoleLabels();
  const kinds = useDocumentKindLabels();
  const f = useFormat();
  const title = row.expiring ? kinds[row.expiring.kind] : roles[row.attachment.role];
  const e = row.expiring;
  const day = e ? f.day(noonOf(e.expiresOn)) : '';
  const runsOut: ReactNode = e ? (
    <Pill tone={DOCUMENT_TONE[e.state]} icon={<ClockIcon />}>
      {e.state === 'expired' ? <Trans>Ran out {day}</Trans> : <Trans>Runs out {day}</Trans>}
    </Pill>
  ) : null;
  return { title, runsOut };
}

function Thumb({ a, large = false }: { a: AttachmentView; large?: boolean }) {
  return a.file?.thumbUrl ? (
    <img
      src={a.file.thumbUrl}
      alt=""
      className={cn(
        'shrink-0 rounded-lg bg-sunken object-cover',
        large ? 'aspect-[4/3] w-full' : 'size-10',
      )}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-lg bg-sunken text-ink-2',
        large ? 'aspect-[4/3] w-full [&_svg]:size-8' : 'size-10 [&_svg]:size-5',
      )}
    >
      <DocumentIcon />
    </span>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <span dir="auto" className="block text-small text-ink-2 italic [overflow-wrap:anywhere]">
      “<bdi>{text}</bdi>”
    </span>
  );
}

function OpenButton({ row, className }: { row: PaperworkRow; className?: string }) {
  const { t } = useLingui();
  const { title } = useRowWords(row);
  const mayHave = useMayHaveOriginal();
  return (
    <FileOpenButton
      attachment={row.attachment}
      original={mayHave(row.subject)}
      {...(row.subject.type === 'thing' ? { thingId: row.subject.id } : {})}
      what={t`${title} for ${row.subject.name}`}
      {...(className ? { className } : {})}
    />
  );
}

/** A list row: icon, what it is and what it belongs to, then Open. */
export function PaperworkListRow({ row }: { row: PaperworkRow }) {
  const { title, runsOut } = useRowWords(row);
  return (
    <article
      aria-label={`${title}${sep()}${row.subject.name}`}
      className="flex items-start gap-3 px-3.5 py-3"
    >
      <Thumb a={row.attachment} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="font-semibold text-[15px] leading-snug text-ink">{title}</div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
          <SubjectLink subject={row.subject} />
          <Path subject={row.subject} />
        </div>
        {runsOut}
        {row.snippet ? <Snippet text={row.snippet} /> : null}
      </div>
      <OpenButton row={row} />
    </article>
  );
}

/** A tile in the Grid layout: the preview first, then the same words, Open across the foot. */
export function PaperworkTile({ row }: { row: PaperworkRow }) {
  const { title, runsOut } = useRowWords(row);
  return (
    <article
      aria-label={`${title}${sep()}${row.subject.name}`}
      className="grid h-full content-start gap-2 rounded-[10px] border border-line bg-surface p-2.5"
    >
      <Thumb a={row.attachment} large />
      <div className="grid min-w-0 gap-1">
        <div className="font-semibold text-[14px] leading-snug text-ink">{title}</div>
        <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
          <SubjectLink subject={row.subject} />
        </div>
        {runsOut}
        {row.snippet ? <Snippet text={row.snippet} /> : null}
      </div>
      <OpenButton row={row} className="w-full" />
    </article>
  );
}
