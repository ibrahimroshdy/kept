/**
 * Search's Documents group (screens §5 Search, frame 04 · 1; §8; plan T21): attachments whose
 * file's text matches (a PDF's text layer, or a receipt's), from `documents` of GET /search.
 *
 * - Each row names the document's role and what it is attached to ("Manual · Bosch drill"), the
 *   location, and an excerpt of the text around the match. The excerpt is plain text: React
 *   escapes it, and only the matched words are marked.
 * - Where the reader can't see money, the server sends no excerpt (`moneyHidden`), and none is
 *   shown: any document's text may hold prices.
 * - A thing or a place opens its page, and so does an incident; a purchase, a reading or a
 *   location has no page of its own here, so its row doesn't link. A step-4 record's document
 *   (a warranty's card, a loan's photos…) comes named by the thing or place it's about.
 * - Offline, the group is a placeholder, "Documents need a connection" (§8): file text is never
 *   kept on the phone (D159).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { DocumentResult, SearchParams, SearchResponse } from '@/api/inventory/types';
import { ChevronEndIcon, CloudOffIcon, DocumentIcon } from '@/components/icons';
import { List, Section } from '@/components/page';
import { rowLink, Tile } from '@/components/places/rows';
import { useRoleLabels } from '@/components/things/labels';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { useSearchGroup } from './api';

const PREVIEW = 5;

type Mark = (text: string) => ReactNode;

function DocumentRow({
  doc,
  locationName,
  mark,
  onOpen,
}: {
  doc: DocumentResult;
  locationName: string;
  mark: Mark;
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  // A step-4 record's document is named by its thing or place; an incident's by the word.
  const name = doc.subject.name ?? (doc.subject.kind === 'incident' ? t`Incident` : t`Untitled`);
  const body = (
    <>
      <Tile>
        <DocumentIcon />
      </Tile>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
          {roles[doc.role]}
          {sep()}
          <bdi>{mark(name)}</bdi>
        </span>
        {locationName ? (
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            <bdi>{locationName}</bdi>
          </span>
        ) : null}
        {doc.snippet && !doc.moneyHidden ? (
          <span
            data-snippet=""
            className="border-s-2 border-line ps-2 text-small text-ink-2 [overflow-wrap:anywhere]"
          >
            <bdi>{mark(doc.snippet)}</bdi>
          </span>
        ) : null}
      </span>
    </>
  );
  if (doc.subject.kind === 'thing')
    return (
      <Link to="/t/$id" params={{ id: doc.subject.id }} onClick={onOpen} className={rowLink}>
        {body}
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    );
  if (doc.subject.kind === 'place')
    return (
      <Link to="/p/$id" params={{ id: doc.subject.id }} onClick={onOpen} className={rowLink}>
        {body}
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    );
  if (doc.subject.kind === 'incident')
    return (
      <Link
        to="/incidents/$id"
        params={{ id: doc.subject.id }}
        onClick={onOpen}
        className={rowLink}
      >
        {body}
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    );
  return <div className="flex min-h-[60px] min-w-0 items-center gap-3 px-3.5 py-2">{body}</div>;
}

/** The Documents group: the first five, and "Show all" (`kind=documents`). */
export function DocumentsGroup({
  params,
  first,
  locationName,
  mark,
  onOpen,
}: {
  params: SearchParams;
  first: SearchResponse;
  locationName: (id: string) => string;
  mark: Mark;
  onOpen?: () => void;
}) {
  const f = useFormat();
  const [all, setAll] = useState(false);
  const full = useSearchGroup(params, 'documents', all);
  const items = all && full.data ? full.data.documents.items : first.documents.items;
  if (items.length === 0) return null;
  return (
    <Section
      title={
        <>
          <Trans>Documents</Trans>{' '}
          <span className="font-normal normal-case tracking-normal text-ink-3">
            {sep()}
            {f.num(items.length)}
          </span>
        </>
      }
    >
      <List>
        {items.map((doc) => (
          <li key={doc.attachmentId}>
            <DocumentRow
              doc={doc}
              locationName={locationName(doc.locationId)}
              mark={mark}
              onOpen={onOpen}
            />
          </li>
        ))}
      </List>
      {!all && first.documents.items.length >= PREVIEW ? (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          onPress={() => setAll(true)}
          isPending={all && full.isPending}
        >
          <Trans>Show all</Trans>
        </Button>
      ) : null}
    </Section>
  );
}

/** Offline: documents are searched on the server only (screens §8). */
export function DocumentsOffline() {
  return (
    <Section title={<Trans>Documents</Trans>}>
      <List>
        <li className="flex min-h-[60px] items-center gap-3 px-3.5 py-2">
          <Tile>
            <CloudOffIcon />
          </Tile>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="font-semibold text-[15px] leading-snug">
              <Trans>Documents need a connection</Trans>
            </span>
            <span className="text-small text-ink-2">
              <Trans>
                Their text isn't kept on this phone. They're searched again when you're back online.
              </Trans>
            </span>
          </span>
        </li>
      </List>
    </Section>
  );
}
