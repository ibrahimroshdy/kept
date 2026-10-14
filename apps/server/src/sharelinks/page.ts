import { CONDITIONS, type Condition, SHARE_LINK_SCOPES, type ShareLinkScope } from '@kept/shared';
import { z } from 'zod';
import { signFile } from '../files/views.js';
import type { FileStorage } from '../storage/blob-store.js';

// A shared page as it leaves the server (D116, D233): the whitelist and nothing else. The doors
// (kept.share_link_open, kept.share_link_preview; migration 0127) already return only name, type,
// place path, quantity, condition, description and a cover photo's derivative keys. Here the keys
// become five-minute signed URLs (Q16, as every file is served) and are dropped; each object is
// built field by field and the response schema is strict, so nothing else can ride along.

const Iso = z.iso.datetime({ offset: true });

const StepSchema = z.strictObject({
  name: z.string().nullable(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
});

const SharedThingSchema = z.strictObject({
  name: z.string().nullable(),
  type: z
    .strictObject({
      icon: z.string().nullable(),
      name: z.string().nullable(),
      builtinKey: z.string().nullable(),
    })
    .nullable(),
  path: z.array(StepSchema),
  quantity: z.number(),
  condition: z.enum(CONDITIONS).nullable(),
  description: z.string().nullable(),
  photo: z.strictObject({ thumbUrl: z.string().nullable(), url: z.string() }).nullable(),
});

const SharedPlaceSchema = z.strictObject({
  name: z.string(),
  isUnplaced: z.boolean(),
  path: z.array(StepSchema),
});

export const SharedPageSchema = z.strictObject({
  scope: z.enum(SHARE_LINK_SCOPES),
  title: z.string().nullable(),
  /** The box (a thing) or the place; null for a filtered list. */
  thing: SharedThingSchema.nullable(),
  place: SharedPlaceSchema.nullable(),
  /** How many things match, and how many a link shows at most (D72). */
  total: z.number().int(),
  cap: z.number().int(),
  page: z.number().int(),
  nextPage: z.number().int().nullable(),
  items: z.array(SharedThingSchema),
  expiresAt: Iso,
});

export type SharedThing = z.infer<typeof SharedThingSchema>;
export type SharedPage = z.infer<typeof SharedPageSchema>;

type DoorStep = { name: string | null; kind: 'place' | 'container'; isUnplaced: boolean };
type DoorThing = {
  name: string | null;
  type: { icon: string | null; name: string | null; builtinKey: string | null } | null;
  path: DoorStep[];
  quantity: number | string;
  condition: Condition | null;
  description: string | null;
  photo: { fileId: string; mime: string; thumb: string | null; large: string | null } | null;
};
type DoorPlace = { name: string; isUnplaced: boolean; path: DoorStep[] };
/** What kept.share_link_contents() returns (0127). */
export type DoorPage = {
  scope: ShareLinkScope;
  title: string | null;
  subject: DoorThing | DoorPlace | null;
  total: number;
  page: number;
  pageSize: number;
  cap: number;
  items: DoorThing[];
  expiresAt: string;
};

const stepsOf = (path: DoorStep[] | null | undefined) =>
  (path ?? []).map((s) => ({ name: s.name, kind: s.kind, isUnplaced: s.isUnplaced === true }));

async function photoOf(
  files: FileStorage | null,
  photo: DoorThing['photo'],
): Promise<SharedThing['photo']> {
  if (!files || !photo?.large) return null;
  const url = (await signFile(files, photo.large, photo.fileId, photo.mime, 'share')).url;
  const thumbUrl = photo.thumb
    ? (await signFile(files, photo.thumb, photo.fileId, photo.mime, 'thumb')).url
    : null;
  return { thumbUrl, url };
}

async function thingOf(files: FileStorage | null, t: DoorThing): Promise<SharedThing> {
  return {
    name: t.name,
    type: t.type ? { icon: t.type.icon, name: t.type.name, builtinKey: t.type.builtinKey } : null,
    path: stepsOf(t.path),
    quantity: Number(t.quantity),
    condition: t.condition,
    description: t.description,
    photo: await photoOf(files, t.photo),
  };
}

/** The door's JSON as the page's response. */
export async function sharedPageOf(files: FileStorage | null, door: DoorPage): Promise<SharedPage> {
  const items = await Promise.all(door.items.map((t) => thingOf(files, t)));
  const shown = door.page * door.pageSize + items.length;
  const more = items.length === door.pageSize && shown < Math.min(door.total, door.cap);
  const subject = door.subject;
  return {
    scope: door.scope,
    title: door.title,
    thing: door.scope === 'thing' && subject ? await thingOf(files, subject as DoorThing) : null,
    place:
      door.scope === 'place' && subject
        ? {
            name: (subject as DoorPlace).name,
            isUnplaced: (subject as DoorPlace).isUnplaced === true,
            path: stepsOf((subject as DoorPlace).path),
          }
        : null,
    total: door.total,
    cap: door.cap,
    page: door.page,
    nextPage: more ? door.page + 1 : null,
    items,
    expiresAt: new Date(door.expiresAt).toISOString(),
  };
}
