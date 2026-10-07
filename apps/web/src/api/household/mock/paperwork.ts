/**
 * Mock handlers for the paperwork library and expiring documents (T12; D39, D155, D172; Q5,
 * Q31). The library lists every receipt, invoice, manual, warranty document and location or place
 * document across your locations with Paperwork on, searchable by the words in a file's text, its
 * subject's name, or a document's title; a receipt's or invoice's snippet needs the money gate
 * (step-3 Q19). An expiring document renews into a new row and keeps the old one in its history.
 */
import { fold, liveThing, matches, paginate, versionError } from '../../inventory/mock/db';
import type { AttachmentView } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  CreateDocumentBody,
  ExpiringDocument,
  PaperworkRow,
  RenewDocumentBody,
  SubjectRef,
  UpdateDocumentBody,
} from '../types';
import {
  documentView,
  ensureSeeded,
  gateFor,
  hh,
  listLocations,
  locationSubject,
  newId,
  placeSubject,
  recordHouseholdEvent,
  resolveSubject,
  showsMoney,
  thingSubject,
} from './db';
import type { StoredDocument } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

/** The roles the library lists: paperwork, never photos or condition photos. */
const LIBRARY_ROLES = new Set([
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'registration',
  'document',
]);
const MONEY_ROLES = new Set(['receipt', 'invoice']);

export function paperworkRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const inv = () => state.inventory;
  const views = (rows: StoredDocument[]) =>
    rows.map((d) => documentView(state, d)).filter((d): d is ExpiringDocument => d !== null);

  /** Where a step-2 attachment sits, as a subject; null when it's gone. */
  const subjectOfAttachment = (a: AttachmentView & { locationId: string }): SubjectRef | null => {
    const s = a.subject;
    if ('thingId' in s) {
      const t = liveThing(inv(), s.thingId);
      return t ? thingSubject(state, t) : null;
    }
    if ('placeId' in s) return placeSubject(state, s.placeId);
    if ('purchaseId' in s) {
      const t = inv().things.find((x) => x.purchase?.purchaseId === s.purchaseId && !x.deletedAt);
      return t ? thingSubject(state, t) : null;
    }
    if ('location' in s) return locationSubject(state, a.locationId);
    return null;
  };

  /** A matching sentence of the file's text, around the first word of `q`. */
  const snippetOf = (text: string | undefined, q: string): string | undefined => {
    if (!text || !q || !matches(text, q)) return undefined;
    const first = fold(q).split(' ')[0] ?? '';
    const words = text.split(/\s+/);
    const at = Math.max(
      0,
      words.findIndex((w) => fold(w).startsWith(first)),
    );
    return words.slice(Math.max(0, at - 6), at + 12).join(' ');
  };

  /**
   * Files held on step-4 records (a lease's PDF, a warranty card) open through step 2's
   * `POST /files/:id/url` like any other: the inventory mock answers for the files it knows.
   */
  const knowFiles = () => {
    const files = inv().files;
    for (const d of h().documents)
      for (const a of d.documents) if (a.file && !files[a.file.id]) files[a.file.id] = a.file;
    for (const w of h().warranties)
      for (const a of w.documents) if (a.file && !files[a.file.id]) files[a.file.id] = a.file;
  };

  const withDocument = (
    id: string | undefined,
    headers: Record<string, string>,
    fn: (d: StoredDocument) => unknown,
  ) => {
    const d = h().documents.find((x) => x.id === id);
    if (!d) return notFound();
    const gated = gateFor(state, d.locationId, 'paperwork', 'write');
    if (gated) return gated;
    const stale = versionError(headers, d);
    if (stale) return reply(stale.status, stale.body);
    return fn(d);
  };

  return [
    route('GET', p.paperwork, ({ query }) => {
      ensureSeeded(state);
      knowFiles();
      const allowed = listLocations(state, 'paperwork');
      const loc = query.get('locationId');
      const role = query.get('role');
      const subjectType = query.get('subjectType');
      const expiry = query.get('expiry') ?? 'any';
      const q = query.get('q')?.trim() ?? '';
      const texts = { ...(inv().fileText ?? {}), ...h().fileText };
      const rows: (PaperworkRow & { locationId: string })[] = [];
      // Step 2's attachments on things, places, purchases and locations.
      for (const a of inv().attachments) {
        if (!LIBRARY_ROLES.has(a.role) || !allowed.has(a.locationId)) continue;
        const subject = subjectOfAttachment(a);
        if (!subject) continue;
        const { locationId, ...attachment } = a;
        rows.push({ attachment, subject, locationId });
      }
      // Files on expiring documents (the lease, the policy), with the document's expiry.
      for (const d of h().documents) {
        if (d.supersededById || !allowed.has(d.locationId)) continue;
        const view = documentView(state, d);
        if (!view) continue;
        for (const attachment of d.documents)
          rows.push({
            attachment,
            subject: view.subject,
            expiring: { id: d.id, kind: d.kind, expiresOn: d.expiresOn, state: view.state },
            locationId: d.locationId,
          });
      }
      // Warranty documents.
      for (const w of h().warranties) {
        const t = liveThing(inv(), w.thingId);
        if (!t || !allowed.has(t.locationId)) continue;
        for (const attachment of w.documents)
          rows.push({ attachment, subject: thingSubject(state, t), locationId: t.locationId });
      }
      const titleOf = new Map(
        h().documents.flatMap((d) => d.documents.map((a) => [a.id, d.title ?? ''] as const)),
      );
      const items = rows
        .filter((r) => {
          if (loc && r.locationId !== loc) return false;
          if (role && r.attachment.role !== role) return false;
          if (subjectType && r.subject.type !== subjectType) return false;
          if (expiry === 'expiring' && r.expiring?.state !== 'expiring') return false;
          if (expiry === 'expired' && r.expiring?.state !== 'expired') return false;
          if (!q) return true;
          const text = r.attachment.file ? texts[r.attachment.file.id] : undefined;
          const hay = [text, r.subject.name, titleOf.get(r.attachment.id)]
            .filter(Boolean)
            .join(' ');
          return matches(hay, q);
        })
        .map(({ locationId, ...r }) => {
          const text = r.attachment.file ? texts[r.attachment.file.id] : undefined;
          const moneyGated = MONEY_ROLES.has(r.attachment.role) && !showsMoney(state, locationId);
          const snippet = moneyGated ? undefined : snippetOf(text, q);
          return snippet ? { ...r, snippet } : r;
        });
      return paginate(items, query, 20);
    }),

    route('GET', p.documents, ({ query }) => {
      ensureSeeded(state);
      knowFiles();
      const allowed = listLocations(state, 'paperwork');
      const loc = query.get('locationId');
      const kind = query.get('kind');
      const subjectType = query.get('subjectType');
      const subjectId = query.get('subjectId');
      const want = query.get('state');
      const superseded = query.get('includeSuperseded') === '1';
      const items = views(
        h().documents.filter(
          (d) =>
            allowed.has(d.locationId) &&
            (!loc || d.locationId === loc) &&
            (!kind || d.kind === kind) &&
            (superseded || !d.supersededById),
        ),
      )
        .filter(
          (d) =>
            (!subjectType || d.subject.type === subjectType) &&
            (!subjectId || d.subject.id === subjectId) &&
            (!want || d.state === want),
        )
        .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
      return paginate(items, query, 20);
    }),
    route('GET', p.document(':id'), ({ params }) => {
      ensureSeeded(state);
      knowFiles();
      const d = h().documents.find((x) => x.id === params.id);
      if (!d) return notFound();
      const gated = gateFor(state, d.locationId, 'paperwork', 'read');
      if (gated) return gated;
      return documentView(state, d) ?? notFound();
    }),
    route('POST', p.documents, ({ body }) => {
      ensureSeeded(state);
      const b = body as CreateDocumentBody;
      const at = resolveSubject(state, b.subject);
      if (!at) return notFound();
      const gated = gateFor(state, at.locationId, 'paperwork', 'write');
      if (gated) return gated;
      if (b.kind === 'other' && !b.title?.trim()) return invalid('title: required for other (Q31)');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiresOn ?? '')) return invalid('expiresOn: a date');
      const row: StoredDocument = {
        id: b.id ?? newId(),
        locationId: at.locationId,
        subject: b.subject,
        kind: b.kind,
        title: b.title?.trim() || null,
        expiresOn: b.expiresOn,
        leadDays: b.leadDays ?? 30,
        supersededById: null,
        documents: [],
        rowVersion: 1,
        createdAt: new Date().toISOString(),
      };
      h().documents.push(row);
      recordHouseholdEvent(state, {
        action: 'document.create',
        entity: { type: 'expiring_document', id: row.id },
        locationId: row.locationId,
        rootThingId: 'thingId' in b.subject ? b.subject.thingId : null,
        name: row.title ?? row.kind,
      });
      return reply(201, documentView(state, row));
    }),
    route('PATCH', p.document(':id'), ({ params, body, headers }) =>
      withDocument(params.id, headers, (d) => {
        const b = body as UpdateDocumentBody;
        const kind = b.kind ?? d.kind;
        const title = b.title === undefined ? d.title : b.title;
        if (kind === 'other' && !title?.trim()) return invalid('title: required for other (Q31)');
        const before = { ...d };
        Object.assign(d, b);
        d.rowVersion += 1;
        recordHouseholdEvent(state, {
          action: 'document.update',
          entity: { type: 'expiring_document', id: d.id },
          locationId: d.locationId,
          rootThingId: 'thingId' in d.subject ? d.subject.thingId : null,
          name: d.title ?? d.kind,
          undo: () => Object.assign(d, before, { rowVersion: d.rowVersion + 1 }),
        });
        return documentView(state, d);
      }),
    ),
    route('DELETE', p.document(':id'), ({ params, headers }) =>
      withDocument(params.id, headers, (d) => {
        h().documents = h().documents.filter((x) => x !== d);
        recordHouseholdEvent(state, {
          action: 'document.delete',
          entity: { type: 'expiring_document', id: d.id },
          locationId: d.locationId,
          rootThingId: 'thingId' in d.subject ? d.subject.thingId : null,
          name: d.title ?? d.kind,
          undo: () => {
            h().documents.push(d);
          },
        });
        return reply(204);
      }),
    ),
    // Renewing keeps the old one (D172): a new row, the old one superseded by it.
    route('POST', p.documentRenew(':id'), ({ params, body, headers }) =>
      withDocument(params.id, headers, (d) => {
        if (d.supersededById) return err(409, 'conflict', 'This was already renewed.');
        const b = body as RenewDocumentBody;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiresOn ?? '')) return invalid('expiresOn: a date');
        const renewed: StoredDocument = {
          ...structuredClone(d),
          id: b.id ?? newId(),
          expiresOn: b.expiresOn,
          leadDays: b.leadDays ?? d.leadDays,
          supersededById: null,
          documents: [],
          rowVersion: 1,
          createdAt: new Date().toISOString(),
        };
        h().documents.push(renewed);
        d.supersededById = renewed.id;
        d.rowVersion += 1;
        recordHouseholdEvent(state, {
          action: 'document.renew',
          entity: { type: 'expiring_document', id: d.id },
          locationId: d.locationId,
          rootThingId: 'thingId' in d.subject ? d.subject.thingId : null,
          name: d.title ?? d.kind,
          // Undo removes the new row and un-supersedes the old one.
          undo: () => {
            h().documents = h().documents.filter((x) => x !== renewed);
            d.supersededById = null;
            d.rowVersion += 1;
          },
        });
        return { renewed: documentView(state, renewed), previous: documentView(state, d) };
      }),
    ),
  ];
}
