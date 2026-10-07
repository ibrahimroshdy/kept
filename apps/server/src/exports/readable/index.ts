import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Condition,
  type Digits,
  type ExportEntity,
  type ExportPdfOutcome,
  formatMoney,
  type Lifecycle,
  printedCode,
} from '@kept/shared';
import type pg from 'pg';
import type { Pools } from '../../db/pools.js';
import { type Scope, withScope } from '../../db/scope.js';
import { downloadName } from '../../files/views.js';
import { notFound } from '../../http/errors.js';
import {
  type GatheredThing,
  MAX_THINGS,
  type ReportOptions,
  readThingsPage,
} from '../../reports/gather.js';
import type { RenderOptions } from '../../reports/render/render.js';
import { prepareInventoryReport, renderPrepared } from '../../reports/service.js';
import { gateFor } from '../../serialize/gates.js';
import type { FileStorage } from '../../storage/blob-store.js';
import type { ReadContext } from '../data.js';
import { entityDef } from '../registry.js';
import { CsvFile, writeEntityCsv } from './csvs.js';
import {
  indexHtml,
  placeHtml,
  type ReadableFileLink,
  type ReadablePlace,
  type ReadableThing,
  type ReadableView,
} from './html.js';
import { readableLocaleOf, readableWords } from './labels.js';
import { copyThumbs, type ThumbJob } from './thumbs.js';

// The readable copy (D159; step-7 plan T13, Q12): one location as plain files a person can read
// with nothing but a browser and a spreadsheet, years from now, with no Kept and no network:
//
//   index.html            the location, its places as a tree, and per place its things
//                         (thumbnail, name, short ID, type, brand and model, serial, quantity,
//                         condition, tags, last seen, purchase date and price where the reader's
//                         money gate shows it), each linking to its photos, receipts and documents
//   places/<placeId>.html a place holding more than 500 things, so no page is huge
//   things.csv places.csv purchases.csv attachments.csv readings.csv, and one per step 4–6
//                         entity (warranties.csv, loans.csv, …): safe CSVs (D169)
//   thumbs/<fileId>.jpg   the 400 px thumbnails of each thing's first photo
//   inventory.pdf         the step-2 report engine's inventory report, up to MAX_THINGS (2,000)
//
// No script, no remote resource, no secret (secret values are never read here, and custom
// fields, where a type's fields live, aren't shown), and nothing the reader's role can't see:
// everything is read in `scope`, under row-level security, as the export's own data is.
//
// **One builder, two callers.** buildReadableCopy() writes into any directory:
// - the Kept export (exports/job.ts) writes it to a scratch directory and packs it under
//   `readable/` in the ZIP, beside `files/<fileId>.<ext>` (`filesHref: '../files'`);
// - step 8's nightly snapshot (backup/readable/, step-8 T6) writes it to
//   `KEPT_DATA_DIR/backup/readable/<locationId>/`, as the location's owner, and places the
//   originals itself (hard links on local storage) at `filesHref/<name>` for each entry of the
//   result's `files`; with S3 storage it asks for photos' display renditions (`target.photos`).
//   The builder copies no original: it only links to them.

export const PLACE_PAGE_THINGS = 500;
const PAGE = 1000;

/** The step-4–6 entities (and the purchases, attachments and readings) with a CSV of their own. */
export const ENTITY_CSVS: readonly ExportEntity[] = [
  'purchases',
  'attachments',
  'readings',
  'warranties',
  'claims',
  'loans',
  'valuations',
  'incidents',
  'expiring-documents',
  'schedules',
  'service-records',
  'service-lines',
  'fuel-entries',
];

export type ReadableTarget = {
  /** The directory the copy is written into (created when missing; it should be empty). */
  dir: string;
  /** Where the originals are, relative to `dir`, as a URL path: `../files` in a Kept export.
   * Each page links an original as `<filesHref>/<fileId>.<ext>` (files/views.ts downloadName). */
  filesHref: string;
  /** `display`: a photo (`files.class = 'photo'`) with a display rendition is linked as that
   * rendition, `<filesHref>/<fileId>-display.jpg`, not its original (the nightly snapshot's copy
   * with S3 file storage, step-8 Q11). Default `original`, the export's. */
  photos?: 'original' | 'display';
};

export type ReadableOptions = {
  /** `ar` writes it in Arabic (right to left); anything else in English (D201). */
  locale: string;
  digits: Digits;
  /** Things no longer in use (sold, lost, …), and things and places in the trash. */
  ended: boolean;
  trashed: boolean;
  /** The inventory PDF, when the location holds at most MAX_THINGS things. */
  pdf: boolean;
};

export type ReadableDeps = {
  pools: Pick<Pools, 'app'>;
  files: FileStorage;
  /** KEPT_PUBLIC_URL, for the PDF's footer. */
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  render?: RenderOptions;
  now?: () => Date;
};

/** An original the pages link to: the caller makes it reachable at `<dir>/<href>`. */
export type ReadableFile = {
  id: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** Its blob (the caller copies or hard-links it; never a path from a request). */
  storageKey: string;
  /** `<filesHref>/<fileId>.<ext>`, relative to `dir`. */
  href: string;
  /** `display` (target.photos): `storageKey` is the display rendition's, a JPEG, and `sha256`
   * is empty (a rendition's hash isn't kept). */
  variant: 'original' | 'display';
};

export type ReadableResult = {
  things: number;
  places: number;
  /** Every original a page links to, once each. */
  files: ReadableFile[];
  pdf: ExportPdfOutcome;
  /** Every file written, relative to `dir`, `/`-separated. */
  written: string[];
};

export type ReadableHooks = {
  /** Called between stages; throw to stop (an export cancelled meanwhile). */
  checkpoint?: () => Promise<void>;
};

type Supplement = {
  id: string;
  last_seen_at: Date | null;
  tags: string[];
  deleted: boolean;
  lifecycle: Lifecycle;
};

type AttachmentRow = {
  thing_id: string;
  file_id: string;
  role: string;
  mime: string;
  bytes: number;
  sha256: string;
  storage_key: string;
  thumb_key: string | null;
  class: string;
  display_key: string | null;
  display_bytes: number | null;
};

type Collected = {
  thing: GatheredThing;
  extra: Supplement | undefined;
  attachments: AttachmentRow[];
  placeId: string;
  inside: string[];
};

type PlaceRow = { id: string; parent_id: string | null; name: string; is_unplaced: boolean };

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

/**
 * Writes the readable copy of `locationId`, as `scope` sees it, into `target.dir`. Returns what it
 * wrote and the originals its pages link to.
 */
export async function buildReadableCopy(
  deps: ReadableDeps,
  scope: Scope,
  locationId: string,
  target: ReadableTarget,
  options: ReadableOptions,
  hooks: ReadableHooks = {},
): Promise<ReadableResult> {
  const now = deps.now ?? (() => new Date());
  const lang = readableLocaleOf(options.locale);
  const words = readableWords(lang);
  const digits: Digits = lang === 'ar' ? options.digits : 'western';
  const intlLocale = lang === 'ar' ? 'ar-EG' : 'en-GB';
  const numberingSystem = digits === 'eastern' ? 'arab' : 'latn';
  const nf = new Intl.NumberFormat(intlLocale, { numberingSystem, maximumFractionDigits: 3 });
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
  const reportOptions: ReportOptions = {
    filters: {
      placeIds: [],
      typeIds: [],
      tagIds: [],
      includeEnded: options.ended,
      includeTrashed: options.trashed,
    },
    include: { photos: false, qr: false, money: true },
    locale: lang,
    digits,
  };
  const checkpoint = hooks.checkpoint ?? (async () => {});
  const written: string[] = [];
  await mkdir(target.dir, { recursive: true });

  // 1. The location, the reader's gate, the places and every thing, page by page.
  const read = await withScope(deps.pools.app, scope, async (tx, client) => {
    const { rows: locs } = await client.query<{
      name: string;
      timezone: string;
      owner_account_id: string;
    }>(
      'SELECT name, timezone, owner_account_id FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
      [locationId],
    );
    const loc = locs[0];
    if (!loc) throw notFound();
    const gate = await gateFor(tx, locationId, scope);
    const { rows: places } = await client.query<PlaceRow>(
      `SELECT id, parent_id, name, is_unplaced FROM public.places
        WHERE location_id = $1 ${options.trashed ? '' : 'AND deleted_at IS NULL'}`,
      [locationId],
    );
    const things: Collected[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await readThingsPage(client, locationId, gate.showMoney, reportOptions, {
        after,
        limit: PAGE,
      });
      if (page.length === 0) break;
      const ids = page.map((t) => t.id);
      const extras = await supplements(client, ids);
      const files = await attachmentsOf(client, ids, gate.showMoney);
      for (const t of page) {
        const placeSteps = t.path.filter((s) => s.kind === 'place');
        const last = placeSteps.at(-1);
        const lastIndex = last ? t.path.lastIndexOf(last) : -1;
        things.push({
          thing: t,
          extra: extras.get(t.id),
          attachments: files.get(t.id) ?? [],
          placeId: last?.id ?? '',
          inside: t.path.slice(lastIndex + 1).map((s) => s.name ?? ''),
        });
      }
      if (page.length < PAGE) break;
      after = page.at(-1)?.id ?? null;
    }
    return { loc, showMoney: gate.showMoney, places, things };
  });
  await checkpoint();

  // 2. The originals and thumbnails the pages link to.
  const filesById = new Map<string, ReadableFile>();
  const thumbJobs: ThumbJob[] = [];
  const asDisplay = (a: AttachmentRow) =>
    target.photos === 'display' && a.class === 'photo' && a.display_key !== null;
  const hrefOf = (a: AttachmentRow) =>
    join(target.filesHref, downloadName(a.file_id, a.mime, asDisplay(a) ? 'display' : 'original'));
  for (const c of read.things) {
    for (const a of c.attachments) {
      if (!filesById.has(a.file_id)) {
        const display = asDisplay(a);
        filesById.set(a.file_id, {
          id: a.file_id,
          mime: display ? 'image/jpeg' : a.mime,
          bytes: display ? Number(a.display_bytes ?? 0) : a.bytes,
          sha256: display ? '' : a.sha256.trim(),
          storageKey: display ? (a.display_key as string) : a.storage_key,
          href: hrefOf(a),
          variant: display ? 'display' : 'original',
        });
      }
    }
    const photo = c.attachments.find((a) => a.role === 'photo' && a.thumb_key);
    if (photo?.thumb_key && !thumbJobs.some((j) => j.fileId === photo.file_id)) {
      thumbJobs.push({ fileId: photo.file_id, key: photo.thumb_key });
    }
  }
  const thumbsDir = path.join(target.dir, 'thumbs');
  await mkdir(thumbsDir, { recursive: true });
  const thumbs = await copyThumbs(deps.files, thumbsDir, thumbJobs, deps.log);
  for (const id of thumbs) written.push(`thumbs/${id}.jpg`);
  await checkpoint();

  // 3. The view: things formatted in the copy's language, grouped by place, the tree in order.
  const dateFmt = new Intl.DateTimeFormat(intlLocale, {
    dateStyle: 'medium',
    timeZone: read.loc.timezone,
    numberingSystem,
  });
  const dayFmt = new Intl.DateTimeFormat(intlLocale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
    numberingSystem,
  });
  const day = (ymd: string | null) => (ymd ? dayFmt.format(new Date(`${ymd}T00:00:00Z`)) : '');
  const statusOf = (c: Collected): string => {
    if (c.thing.trashed) return words.trashed;
    const life = c.thing.lifecycle as Lifecycle;
    return life === 'in_use' ? '' : (words.lifecycles[life] ?? life);
  };
  const viewThing = (c: Collected): ReadableThing => {
    const t = c.thing;
    const counts = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const a of c.attachments) totals.set(a.role, (totals.get(a.role) ?? 0) + 1);
    const links: ReadableFileLink[] = c.attachments.map((a) => {
      const n = (counts.get(a.role) ?? 0) + 1;
      counts.set(a.role, n);
      const label = words.fileRole[a.role] ?? a.role;
      return {
        label: (totals.get(a.role) ?? 0) > 1 ? `${label} ${nf.format(n)}` : label,
        href: hrefOf(a),
      };
    });
    const photo = c.attachments.find((a) => a.role === 'photo' && thumbs.has(a.file_id));
    const money = t.money;
    const price =
      money?.unitPrice && money.currency
        ? formatMoney(money.unitPrice, money.currency, { locale: intlLocale, digits })
        : '';
    return {
      id: t.id,
      name: t.name,
      shortId: t.shortCode ? printedCode(t.shortCode) : '',
      type: t.typeName ?? '',
      brandModel: [t.brand, t.model].filter(Boolean).join(' '),
      serial: t.serial ?? '',
      quantity: nf.format(Number(t.quantity)),
      condition: t.condition ? (words.conditions[t.condition as Condition] ?? t.condition) : '',
      status: statusOf(c),
      tags: c.extra?.tags ?? [],
      lastSeen: c.extra?.last_seen_at ? dateFmt.format(c.extra.last_seen_at) : '',
      bought: [day(money?.purchasedOn ?? null), price].filter(Boolean).join(', '),
      inside: c.inside.filter(Boolean),
      thumb: photo ? `thumbs/${photo.file_id}.jpg` : null,
      photoHref: photo ? hrefOf(photo) : null,
      files: links,
    };
  };

  const byPlace = new Map<string, ReadableThing[]>();
  const sorted = [...read.things].sort((a, b) => collator.compare(a.thing.name, b.thing.name));
  for (const c of sorted) {
    const list = byPlace.get(c.placeId) ?? [];
    list.push(viewThing(c));
    byPlace.set(c.placeId, list);
  }
  const children = new Map<string | null, PlaceRow[]>();
  const known = new Set(read.places.map((p) => p.id));
  for (const p of read.places) {
    const parent = p.parent_id && known.has(p.parent_id) ? p.parent_id : null;
    const list = children.get(parent) ?? [];
    list.push(p);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) =>
      a.is_unplaced !== b.is_unplaced ? (a.is_unplaced ? 1 : -1) : collator.compare(a.name, b.name),
    );
  }
  const count = (n: number) => words.thingCount(n, nf.format(n));
  const places: ReadablePlace[] = [];
  const walk = (parent: string | null, depth: number): number => {
    let sum = 0;
    for (const p of children.get(parent) ?? []) {
      const here = byPlace.get(p.id) ?? [];
      const entry: ReadablePlace = {
        id: p.id,
        name: p.is_unplaced ? words.unplaced : p.name,
        depth,
        things: here,
        total: 0,
        totalText: '',
        countText: count(here.length),
        ownPage: here.length > PLACE_PAGE_THINGS,
      };
      places.push(entry);
      entry.total = here.length + walk(p.id, depth + 1);
      entry.totalText = nf.format(entry.total);
      sum += entry.total;
    }
    return sum;
  };
  walk(null, 0);
  const loose = byPlace.get('') ?? [];
  if (loose.length > 0) {
    places.push({
      id: '',
      name: words.unplaced,
      depth: 0,
      things: loose,
      total: loose.length,
      totalText: nf.format(loose.length),
      countText: count(loose.length),
      ownPage: loose.length > PLACE_PAGE_THINGS,
    });
  }
  await checkpoint();

  // 4. The spreadsheets.
  const csvs: string[] = [];
  const thingsCsv = new CsvFile(path.join(target.dir, 'things.csv'), [
    'id',
    'short_id',
    'name',
    'place',
    'inside',
    'type',
    'brand',
    'model',
    'serial',
    'quantity',
    'condition',
    'lifecycle',
    'trashed',
    'tags',
    'last_seen_at',
    ...(read.showMoney ? ['purchased_on', 'unit_price', 'currency'] : []),
  ]);
  const placeName = new Map(
    read.places.map((p) => [p.id, p.is_unplaced ? words.unplaced : p.name]),
  );
  try {
    for (const c of read.things) {
      const t = c.thing;
      await thingsCsv.line([
        t.id,
        t.shortCode ?? '',
        t.name,
        c.placeId ? (placeName.get(c.placeId) ?? '') : words.unplaced,
        c.inside.join(' > '),
        t.typeName ?? '',
        t.brand ?? '',
        t.model ?? '',
        t.serial ?? '',
        t.quantity,
        t.condition ?? '',
        t.lifecycle,
        t.trashed,
        (c.extra?.tags ?? []).join(', '),
        c.extra?.last_seen_at?.toISOString() ?? '',
        ...(read.showMoney
          ? [t.money?.purchasedOn ?? '', t.money?.unitPrice ?? '', t.money?.currency ?? '']
          : []),
      ]);
    }
  } finally {
    await thingsCsv.close();
  }
  csvs.push('things.csv');
  const placesCsv = new CsvFile(path.join(target.dir, 'places.csv'), [
    'id',
    'name',
    'parent_id',
    'parent',
    'things_here',
    'things_inside',
  ]);
  try {
    for (const p of places) {
      if (!p.id) continue;
      const row = read.places.find((r) => r.id === p.id);
      await placesCsv.line([
        p.id,
        p.name,
        row?.parent_id ?? '',
        row?.parent_id ? (placeName.get(row.parent_id) ?? '') : '',
        p.things.length,
        p.total,
      ]);
    }
  } finally {
    await placesCsv.close();
  }
  csvs.push('places.csv');
  const thingNames = new Map(read.things.map((c) => [c.thing.id, c.thing.name]));
  const ctx: ReadContext = {
    locationId,
    accountId: read.loc.owner_account_id,
    showMoney: read.showMoney,
    ended: options.ended,
    trashed: options.trashed,
  };
  await withScope(deps.pools.app, scope, async (_tx, client) => {
    for (const entity of ENTITY_CSVS) {
      const def = entityDef(entity);
      if (!def) continue;
      const name = `${entity}.csv`;
      await writeEntityCsv(client, def, ctx, path.join(target.dir, name), thingNames);
      csvs.push(name);
    }
  });
  written.push(...csvs);
  await checkpoint();

  // 5. The inventory PDF, within the report's cap.
  let pdf: ExportPdfOutcome = 'off';
  if (options.pdf) {
    pdf = read.things.length > MAX_THINGS ? 'too_many_things' : await renderPdf();
  }
  async function renderPdf(): Promise<ExportPdfOutcome> {
    await mkdir(deps.files.tmpDir, { recursive: true });
    const work = await mkdtemp(path.join(deps.files.tmpDir, 'readable-pdf-'));
    try {
      const prepared = await withScope(deps.pools.app, scope, (tx, client) =>
        prepareInventoryReport(
          tx,
          client,
          scope,
          {
            locationIds: [locationId],
            scope: { locationId },
            options: { ...reportOptions, include: { photos: true, qr: false, money: true } },
          },
          { publicUrl: deps.publicUrl, now },
        ),
      );
      const rendered = await renderPrepared(deps.files, work, prepared, {
        publicUrl: deps.publicUrl,
        log: deps.log,
        render: deps.render ?? {},
      });
      await copyFile(rendered.file, path.join(target.dir, 'inventory.pdf'));
      written.push('inventory.pdf');
      return 'included';
    } catch (err) {
      deps.log.error({ err, locationId }, 'readable copy: the inventory PDF was not made');
      return (err as { name?: string })?.name === 'TooManyThingsError'
        ? 'too_many_things'
        : 'failed';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  await checkpoint();

  // 6. The pages.
  const view: ReadableView = {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    words,
    location: read.loc.name,
    exported: words.exported(dateFmt.format(now())),
    thingCount: count(read.things.length),
    placeCount: `${words.places}: ${nf.format(read.places.length)}`,
    showMoney: read.showMoney,
    pdf:
      pdf === 'included'
        ? { href: 'inventory.pdf' }
        : pdf === 'too_many_things'
          ? { note: words.pdfLeftOut(nf.format(MAX_THINGS)) }
          : pdf === 'failed'
            ? { note: words.pdfFailed }
            : null,
    csvs,
    places,
  };
  const bigPlaces = places.filter((p) => p.ownPage);
  if (bigPlaces.length > 0) await mkdir(path.join(target.dir, 'places'), { recursive: true });
  for (const p of bigPlaces) {
    const name = `places/${p.id || 'unplaced'}.html`;
    await writeFile(path.join(target.dir, name), placeHtml(view, p), { mode: 0o600 });
    written.push(name);
  }
  await writeFile(path.join(target.dir, 'index.html'), indexHtml(view), { mode: 0o600 });
  written.push('index.html');

  return {
    things: read.things.length,
    places: read.places.length,
    files: [...filesById.values()],
    pdf,
    written: written.sort(),
  };
}

/** Tags, last seen and state of a page of things. */
async function supplements(client: pg.ClientBase, ids: string[]): Promise<Map<string, Supplement>> {
  const { rows } = await client.query<Supplement>(
    `SELECT t.id, t.last_seen_at, t.deleted_at IS NOT NULL AS deleted, t.lifecycle,
            ARRAY(SELECT tg.name FROM public.thing_tags g JOIN public.tags tg ON tg.id = g.tag_id
                   WHERE g.thing_id = t.id ORDER BY lower(tg.name), tg.id) AS tags
       FROM public.things t WHERE t.id = ANY ($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** A page of things' attachments, in their order, and (where money shows) their purchase's
 * receipts and invoices. */
async function attachmentsOf(
  client: pg.ClientBase,
  ids: string[],
  showMoney: boolean,
): Promise<Map<string, AttachmentRow[]>> {
  const purchase = showMoney
    ? `UNION ALL
       SELECT t.id, a.file_id, a.role, f.mime, f.bytes::float8, f.sha256, f.storage_key, NULL,
              f.class, dd.storage_key, dd.bytes::float8, 1, a.sort, a.created_at, a.id
         FROM public.things t
         JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
         JOIN public.attachments a ON a.purchase_id = pl.purchase_id AND a.file_id IS NOT NULL
         JOIN public.files f ON f.id = a.file_id
         LEFT JOIN public.file_derivatives dd ON dd.file_id = f.id AND dd.variant = 'display'
        WHERE t.id = ANY ($1::uuid[])`
    : '';
  const { rows } = await client.query<AttachmentRow>(
    `SELECT thing_id, file_id, role, mime, bytes, sha256, storage_key, thumb_key, class,
            display_key, display_bytes FROM (
       SELECT a.thing_id, a.file_id, a.role, f.mime, f.bytes::float8 AS bytes, f.sha256,
              f.storage_key, d.storage_key AS thumb_key, f.class, dd.storage_key AS display_key,
              dd.bytes::float8 AS display_bytes, 0 AS src, a.sort, a.created_at, a.id
         FROM public.attachments a
         JOIN public.files f ON f.id = a.file_id
         LEFT JOIN public.file_derivatives d ON d.file_id = f.id AND d.variant = 'thumb'
         LEFT JOIN public.file_derivatives dd ON dd.file_id = f.id AND dd.variant = 'display'
        WHERE a.thing_id = ANY ($1::uuid[])
       ${purchase}
     ) x
     ORDER BY thing_id, src, sort, created_at, id`,
    [ids],
  );
  const out = new Map<string, AttachmentRow[]>();
  for (const r of rows) {
    const list = out.get(r.thing_id) ?? [];
    if (!list.some((a) => a.file_id === r.file_id)) list.push(r);
    out.set(r.thing_id, list);
  }
  return out;
}
