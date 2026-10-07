/**
 * Mock handlers for uploads, signed URLs and attachments (task 17). An upload is accepted as
 * whatever body arrives; the checksum header is echoed. Task 26 extends these as it needs.
 */
import type { MockState } from '../../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { inventoryPaths as p } from '../paths';
import type { AttachmentView, CreateAttachmentBody, FileClass, FileView } from '../types';
import { accessOf, newId, paginate } from './db';

/** A 1×1 amber PNG, for thumbs and display URLs in tests and the demo. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Which location each uploaded file belongs to, for the per-location dedupe (D177). */
const fileLocations = new WeakMap<object, Map<string, string>>();

export function filesRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const access = () => accessOf(state);
  const locOf = () => {
    let m = fileLocations.get(state);
    if (!m) {
      m = new Map();
      fileLocations.set(state, m);
    }
    return m;
  };

  return [
    route('PUT', p.file(':id'), ({ params, query, headers }) => {
      const locationId = query.get('locationId') ?? '';
      if (!access().visible(locationId)) return notFound();
      if (!access().canWrite(locationId)) return forbidden();
      const sha256 = headers['x-kept-sha256'] ?? '';
      if (!/^[0-9a-f]{64}$/.test(sha256))
        return err(400, 'validation', 'X-Kept-Sha256 is required.');
      // Task 26: a duplicate only within the same location (D177), and a replay of the same id.
      const replay = inv().files[params.id ?? ''];
      if (replay)
        return replay.sha256 === sha256
          ? replay
          : err(409, 'idempotency_mismatch', 'That file id was used for other bytes.');
      const existing = Object.values(inv().files).find(
        (f) => f.sha256 === sha256 && locOf().get(f.id) === locationId,
      );
      if (existing) return { ...existing, deduplicatedFrom: existing.id };
      const mime = headers['content-type'] ?? 'application/octet-stream';
      const heic = /hei[cf]/.test(mime);
      const image = mime.startsWith('image/');
      const file: FileView = {
        id: params.id ?? newId(),
        sha256,
        bytes: Number(headers['content-length'] ?? 0),
        mime,
        class: (query.get('class') as FileClass | null) ?? 'photo',
        hasGps: false,
        width: image ? 1 : null,
        height: image ? 1 : null,
        derivativeState: heic ? 'unavailable' : image ? 'ready' : 'not_applicable',
        thumbUrl: image && !heic ? PIXEL : null,
        displayUrl: image && !heic ? PIXEL : null,
      };
      inv().files[file.id] = file;
      locOf().set(file.id, locationId);
      return reply(201, file);
    }),

    route('POST', p.fileUrl(':id'), ({ params, body }) => {
      const file = inv().files[params.id ?? ''];
      if (!file) return notFound();
      const variant = (body as { variant: string }).variant;
      const loc = inv().attachments.find((a) => a.file?.id === file.id)?.locationId;
      if (variant === 'original' && loc && !access().canWrite(loc)) return forbidden();
      return { url: PIXEL, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    }),

    route('POST', p.attachments, ({ body }) => {
      const b = body as CreateAttachmentBody;
      if (!access().visible(b.locationId)) return notFound();
      if (!access().canWrite(b.locationId)) return forbidden();
      const view: AttachmentView & { locationId: string } = {
        id: b.id ?? newId(),
        role: b.role,
        sort: b.sort ?? 0,
        file: b.fileId ? (inv().files[b.fileId] ?? null) : null,
        url: b.url ?? null,
        subject: b.subject,
        createdBy: { displayName: state.me.user.displayName },
        rowVersion: 1,
        locationId: b.locationId,
      };
      inv().attachments.push(view);
      // A warranty's or claim's document, a loan's condition photo (step 4, T20).
      inv().step4?.attach(view);
      if ('thingId' in b.subject) {
        const thingId = b.subject.thingId;
        const t = inv().things.find((x) => x.id === thingId);
        if (t) {
          t.attachmentsCount += 1;
          if (b.role === 'photo') {
            const { locationId: _l, ...plain } = view;
            t.photos.push(plain);
            t.thumbUrl ??= view.file?.thumbUrl ?? null;
          }
        }
      }
      const { locationId: _l, ...out } = view;
      return reply(201, out);
    }),

    route('DELETE', p.attachment(':id'), ({ params }) => {
      const a = inv().attachments.find((x) => x.id === params.id);
      if (!a || !access().visible(a.locationId)) return notFound();
      if (!access().canWrite(a.locationId)) return forbidden();
      inv().attachments = inv().attachments.filter((x) => x.id !== params.id);
      inv().step4?.detach(a);
      // Task 26: the thing's photo strip and count follow.
      if ('thingId' in a.subject) {
        const thingId = a.subject.thingId;
        const t = inv().things.find((x) => x.id === thingId);
        if (t) {
          t.attachmentsCount = Math.max(0, t.attachmentsCount - 1);
          t.photos = t.photos.filter((ph) => ph.id !== a.id);
          t.thumbUrl = t.photos[0]?.file?.thumbUrl ?? null;
        }
      }
      return reply(204);
    }),

    route('GET', p.thingAttachments(':id'), ({ params, query }) => {
      const role = query.get('role');
      const items = inv()
        .attachments.filter((a) => 'thingId' in a.subject && a.subject.thingId === params.id)
        .filter((a) => !role || a.role === role)
        .map(({ locationId: _l, ...a }) => a);
      return paginate(items, query);
    }),
  ];
}
