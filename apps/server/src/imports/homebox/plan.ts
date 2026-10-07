import {
  fieldValueSchema,
  HB_FIELD_KIND,
  type HomeboxChoices,
  homeboxAssetCode,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueParams,
  type ImportIssueRef,
  normalize,
  parseAmount,
} from '@kept/shared';
import type { ArchiveReportRow, HomeboxDryRunSummary } from '../archive-types.js';
import { legacyCodeOf } from '../csv.js';
import {
  type HbAttachment,
  type HbEntity,
  type HbEntityField,
  type HbEntityType,
  hbDate,
} from './format.js';
import { keptIcon } from './icons.js';
import type { HbLookups } from './lookups.js';
import {
  attachmentEntry,
  type HomeboxData,
  isLocation,
  seededUnused,
  templateTagIds,
} from './read.js';

// The Homebox mapping (D146, rule by rule; step-7 plan T9). planHomebox() is pure: over the
// archive's tables (read.ts), the run's choices and the target's lookups (lookups.ts) it answers
// the steps the job takes, in apply order, and the dry run's report. The dry run stores the
// report and writes nothing; the job (apply.ts, T10) works the same steps through the step-2
// services, each remembered in import_source_ids (source `homebox`, plan Q2) under its `key`, so
// a resumed or re-run import skips what is done.
//
// - each collection → the run's location; location-type entities → places, keeping the tree
//   (top-level a room, below it a zone, as the CSV import makes them); a location inside an item
//   → a container thing (`hb_location_in_item`), because places can't sit inside things;
// - other entities → things; one holding others is a container: its type gets the `container`
//   capability when this import creates it, else the thing is a "Box / bin";
// - entity types → Kept types by the `types` choice (or by normalised name), else created, with
//   icons per spike H2 (`hb_icon_dropped`);
// - description, a blank line, then notes; manufacturer → brand, model, serial;
// - purchase date, from and price → a one-line purchase (D115) in the `currency` choice, its
//   vendor by name; warranty expiry or lifetime → a warranty from the purchase date; sold → the
//   thing ended `sold` with its date, price, buyer and notes;
// - tags → tags with colours, flattened (each ancestor tag applied too); tag icons dropped;
// - custom fields → the mapped type's field of the same normalised label and kind, else by the
//   `fields` choice: added to the type (a built-in is customised first) or kept in the notes;
// - `insured` → a yes/no "Insured" field on the type, per the `insured` choice (Q25);
// - quantity 0 → 1 (`hb_quantity_zero`); fractional kept (D183) unless the type counts one by
//   one (serialized, metered: `hb_quantity_rounded`, the original in the notes);
// - archived → skipped (`hb_archived_skipped`) or tagged "Archived in Homebox";
// - Homebox's seeded places and tags, empty and unused, skipped by default (`hb_seeded_skipped`);
// - attachments: photo (the primary first), manual, warranty → the warranty's document, receipt
//   → the purchase's receipt, attachment → document; thumbnails skipped; links → link
//   attachments; a type Kept doesn't keep → `file_type_refused` (Q15), listed;
// - maintenance done → a service record; only scheduled → a one-off schedule;
// - templates → account templates, best effort (`hb_template_partial`);
// - dates are the UTC date part; a `time` field within a second of its row's creation is empty
//   (`hb_time_default`, spike H1's heuristic); notifiers never read (`hb_notifier_skipped`);
// - legacy codes: every asset ID (`000-001`) and entity UUID, collection = manifest.groupId; one
//   the location already has is `code_taken`.
// Where a record's module is off in the location, or it can't be made (no start date for a
// warranty, more than one of the thing), its text stays in the thing's notes (`hb_needs_module`).

/** Something an op points at: another op of this import (by its source id, resolved through
 * import_source_ids and what the job made), or a row that already exists. */
export type Ref = { key: string } | { id: string };
/** A registry row by name, made when missing (brands, vendors). */
export type NameRef = { id: string } | { create: string };

export type PlannedField = { sourceKey: string; key: string; label: string; kind: string };

export type TypeOp = {
  op: 'type';
  key: string;
  /** Homebox's name, for the report. */
  name: string;
  target: { id: string } | { create: { name: string; icon: string } };
  /** A built-in that gains fields is copied into the account first (kept.customise_type). */
  customise: boolean;
  /** Created here and holding things: made a container. */
  container: boolean;
  fields: PlannedField[];
};

export type TagOp = {
  op: 'tag';
  key: string;
  target: { id: string } | { create: { name: string; colour: string | null } };
};

export type PlaceOp = {
  op: 'place';
  key: string;
  name: string;
  parent: Ref | null;
  /** A live place of the same name under the same parent: kept, not made again. */
  existingId: string | null;
  codes: string[];
};

export type ThingOp = {
  op: 'thing';
  key: string;
  name: string;
  where: { place: Ref } | { container: Ref };
  type: Ref | null;
  quantity: number;
  brand: NameRef | null;
  model: string | null;
  serial: string | null;
  notes: string | null;
  tags: Ref[];
  custom: Record<string, unknown>;
  purchase: {
    key: string;
    purchasedOn: string;
    price: string;
    currency: string;
    vendor: NameRef | null;
  } | null;
  sold: {
    endedOn?: string;
    endedPrice?: string;
    endedCurrency?: string;
    endedTo?: string;
    endedNotes?: string;
  } | null;
  codes: string[];
};

export type WarrantyOp = {
  op: 'warranty';
  key: string;
  thing: Ref;
  body: { kind: 'manufacturer'; startsOn: string; endsOn?: string; lifetime?: true };
};

export type AttachmentOp = {
  op: 'attachment';
  key: string;
  owner: { thing: Ref } | { place: Ref };
  /** Where it hangs: the thing or place itself, its warranty, or its purchase (by their keys). */
  subject: 'owner' | 'warranty' | 'purchase';
  role: string;
  sort: number;
  title: string;
  file: { entry: string; mime: string; bytes: number } | null;
  url: string | null;
};

export type ServiceOp = {
  op: 'service';
  key: string;
  owner: { thing: Ref } | { place: Ref };
  servicedOn: string;
  notes: string;
  total: string | null;
  currency: string | null;
};

export type ScheduleOp = {
  op: 'schedule';
  key: string;
  owner: { thing: Ref } | { place: Ref };
  name: string;
  dueOn: string;
};

export type TemplateOp = {
  op: 'template';
  key: string;
  name: string;
  payload: {
    name?: string;
    model?: string;
    quantity?: number;
    notes?: string;
    tags: Ref[];
    brand: NameRef | null;
  };
};

export type HbOp =
  | TypeOp
  | TagOp
  | PlaceOp
  | ThingOp
  | WarrantyOp
  | AttachmentOp
  | ServiceOp
  | ScheduleOp
  | TemplateOp;

export type HbPlan = {
  ops: HbOp[];
  report: { source: 'homebox_zip'; summary: HomeboxDryRunSummary; rows: ArchiveReportRow[] };
};

const LIMITS = { name: 200, model: 120, serial: 100, brand: 120, vendor: 120, tag: 60 } as const;
const NOTES_MAX = 5000;
const TEXT_MAX = 2000;
const TYPE_NAME_MAX = 80;
const FIELD_LABEL_MAX = 80;
const TAGS_MAX = 50;
const URL_MAX = 2000;
/** Kept's attachment roles for Homebox's kinds (D146). */
const ROLE: Record<string, string> = {
  photo: 'photo',
  manual: 'manual',
  warranty: 'warranty_doc',
  receipt: 'receipt',
  attachment: 'document',
};
/** What an import can store (storage/sniff.ts, without video): photos and PDF (D157, Q15). */
const KEPT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/gif',
  'application/pdf',
]);
/** CSS's basic colour keywords, for a tag colour written as a name (Homebox stores any text). */
const NAMED_COLOURS: Record<string, string> = {
  black: '#000000',
  silver: '#C0C0C0',
  gray: '#808080',
  grey: '#808080',
  white: '#FFFFFF',
  maroon: '#800000',
  red: '#FF0000',
  purple: '#800080',
  fuchsia: '#FF00FF',
  green: '#008000',
  lime: '#00FF00',
  olive: '#808000',
  yellow: '#FFFF00',
  navy: '#000080',
  blue: '#0000FF',
  teal: '#008080',
  aqua: '#00FFFF',
  orange: '#FFA500',
};
export const ARCHIVED_TAG = 'Archived in Homebox';
const INSURED_LABEL = 'Insured';

const MESSAGES: Partial<Record<ImportIssueCode, string>> = {
  hb_archived_skipped: 'Archived in Homebox, left out.',
  hb_quantity_rounded: "Counted one by one in Kept; Homebox's quantity is kept in the notes.",
  hb_quantity_zero: 'Quantity 0 became 1: Homebox gives 0 when none was set.',
  hb_number_integer: 'Homebox keeps numbers whole, so any decimals were already lost there.',
  hb_icon_dropped: "Kept has no icon like Homebox's; the type's own icon is used.",
  hb_template_partial: "A Kept template can't hold money or secrets; the rest is imported.",
  hb_currency_unsupported:
    "This currency isn't turned on in Kept; the prices are kept in the notes.",
  hb_needs_module: "Kept can't hold this record here; its text is kept in the thing's notes.",
  hb_location_in_item: 'A location inside an item became a container.',
  hb_notifier_skipped: 'Notifiers are never imported: their addresses can hold passwords.',
  hb_seeded_skipped: "One of Homebox's starter places or tags, empty and unused, left out.",
  hb_time_default: 'A date Homebox filled in with the day the item was made; read as empty.',
  already_imported: 'Already imported by an earlier import, so it is skipped.',
  no_name: "No name, so it's skipped.",
  too_long: 'Too long; kept in the notes.',
  brand_too_long: 'Longer than a brand name can be; kept in the notes.',
  vendor_too_long: 'Longer than a shop name can be; kept in the notes.',
  money_off: 'Money is turned off in this location; kept in the notes.',
  future_date: 'The date is in the future; kept in the notes.',
  needs_price: 'A purchase needs a price; kept in the notes.',
  needs_date: 'A price needs a purchase date; kept in the notes.',
  not_type_field: "Not a field of this item's type; kept in the notes.",
  not_field_value: 'Not a value this field can hold; kept in the notes.',
  tag_not_added: 'Not added as a tag (too long, or too many tags).',
  not_link: 'Not a web link (http or https).',
  code_taken: "This code is already on something else, so it isn't added.",
  notes_cut: 'The notes are cut to fit.',
  file_type_refused: "Not imported: a file type Kept doesn't keep.",
  file_missing: "The file isn't in the archive, so it's left out.",
  file_too_large: "The file is larger than Kept takes, so it's left out.",
  entry_ignored: "This row doesn't read as Homebox's export format; left out.",
};

const amountOf = (n: number): string => parseAmount(n.toFixed(2));

/** A field key for `label`, unique among `used` (KEY: ^[a-z][a-z0-9_]{0,39}$). */
function fieldKey(label: string, used: Set<string>): string {
  const slug = normalize(label)
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const base = /^[a-z]/.test(slug) ? slug : `field${slug ? `_${slug}` : ''}`.slice(0, 32);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  used.add(key);
  return key;
}

function colourOf(color: string): string | null {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  }
  return NAMED_COLOURS[c] ?? null;
}

const isHttp = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Builds the report's rows: one per entity, attachment, maintenance entry or template with
 * something to say. */
class Report {
  readonly rows = new Map<string, ArchiveReportRow>();

  row(ref: ImportIssueRef): ArchiveReportRow {
    const id = `${ref.kind}:${ref.id}`;
    let row = this.rows.get(id);
    if (!row) {
      row = { status: 'ok', ref, issues: [] };
      this.rows.set(id, row);
    }
    return row;
  }

  issue(
    ref: ImportIssueRef,
    code: ImportIssueCode,
    opts: { status?: 'text' | 'skipped'; params?: ImportIssueParams; column?: string } = {},
  ): void {
    const row = this.row(ref);
    if (opts.status === 'skipped' || (opts.status === 'text' && row.status !== 'skipped')) {
      row.status = opts.status;
    }
    if (row.issues.some((i) => i.code === code && i.column === (opts.column ?? ''))) return;
    const issue: ImportIssue = {
      column: opts.column ?? '',
      code,
      message: MESSAGES[code] ?? code,
      ref,
      ...(opts.params ? { params: opts.params } : {}),
    };
    row.issues.push(issue);
  }

  text(ref: ImportIssueRef): void {
    const row = this.row(ref);
    if (row.status === 'ok') row.status = 'text';
  }
}

type TypeState = {
  op: TypeOp;
  /** The fields a thing of this type can carry: existing (resolved) and planned here. */
  fields: { key: string; label: string; kind: string; usable: boolean }[];
  caps: string[];
  used: Set<string>;
  /** Created here (no existing row). */
  created: boolean;
  emitted: boolean;
};

export function planHomebox(data: HomeboxData, choices: HomeboxChoices, look: HbLookups): HbPlan {
  const report = new Report();
  const ops = {
    types: [] as TypeOp[],
    tags: [] as TagOp[],
    places: [] as PlaceOp[],
    things: [] as ThingOp[],
    warranties: [] as WarrantyOp[],
    attachments: [] as AttachmentOp[],
    maintenance: [] as (ServiceOp | ScheduleOp)[],
    templates: [] as TemplateOp[],
  };
  const summary: HomeboxDryRunSummary = {
    places: 0,
    things: 0,
    containers: 0,
    purchases: 0,
    warranties: 0,
    services: 0,
    schedules: 0,
    attachments: 0,
    links: 0,
    tags: 0,
    types: 0,
    fieldsAdded: 0,
    legacyCodes: 0,
    skipped: 0,
    asText: 0,
    refusedFiles: 0,
  };
  const done = (key: string) => look.sourceIds.has(key);
  const entityRef = (e: HbEntity): ImportIssueRef => ({ kind: 'entity', id: e.id, name: e.name });
  const currency = choices.currency;
  /** Why money can't be written here, or null when it can. */
  const moneyBlock: ImportIssueCode | null = !look.showMoney
    ? 'money_off'
    : look.currencies.has(currency)
      ? null
      : 'hb_currency_unsupported';

  // --- rows the archive couldn't give, and notifiers -------------------------------------------
  for (const bad of data.bad) {
    const kind =
      bad.table === 'attachments'
        ? 'attachment'
        : bad.table === 'maintenance_entries'
          ? 'maintenance'
          : bad.table === 'entity_templates' || bad.table === 'template_fields'
            ? 'template'
            : 'entity';
    report.issue(
      { kind, id: bad.id ?? `${bad.table}:${bad.index}`, ...(bad.name ? { name: bad.name } : {}) },
      'entry_ignored',
      { status: 'skipped' },
    );
  }
  const notifiers = data.manifest.counts.notifiers ?? 0;
  if (notifiers > 0) {
    report.issue({ kind: 'file', id: 'notifiers.json', name: 'notifiers' }, 'hb_notifier_skipped', {
      status: 'skipped',
      params: { max: notifiers },
    });
  }

  // --- the tree ---------------------------------------------------------------------------------
  const entities = [...data.entities.values()];
  const parentOf = (e: HbEntity): HbEntity | null =>
    e.entity_children ? (data.entities.get(e.entity_children) ?? null) : null;
  const children = new Map<string, HbEntity[]>();
  for (const e of entities) {
    const p = parentOf(e);
    if (!p) continue;
    const list = children.get(p.id) ?? [];
    list.push(e);
    children.set(p.id, list);
  }
  /** A place in Kept: a location whose ancestors are all locations. */
  const placeLike = new Map<string, boolean>();
  const isPlace = (e: HbEntity): boolean => {
    const known = placeLike.get(e.id);
    if (known !== undefined) return known;
    placeLike.set(e.id, false); // a cycle reads as "not a place"
    const p = parentOf(e);
    const value = isLocation(data, e) && (!p || isPlace(p));
    placeLike.set(e.id, value);
    return value;
  };

  const seeded = seededUnused(data);
  const skipped = new Set<string>();
  for (const e of entities) {
    const ref = entityRef(e);
    if (!e.name.trim()) {
      report.issue(ref, 'no_name', { status: 'skipped' });
      skipped.add(e.id);
    } else if (choices.seeded === 'skip_unused' && seeded.places.has(e.id)) {
      report.issue(ref, 'hb_seeded_skipped', { status: 'skipped' });
      skipped.add(e.id);
    } else if (e.archived && choices.archived === 'skip') {
      report.issue(ref, 'hb_archived_skipped', { status: 'skipped' });
      skipped.add(e.id);
    } else if (done(e.id)) {
      report.issue(ref, 'already_imported', { status: 'skipped' });
    }
  }
  /** The nearest ancestor that is (or was) imported. */
  const keptParent = (e: HbEntity): HbEntity | null => {
    const seen = new Set<string>([e.id]);
    let p = parentOf(e);
    while (p && skipped.has(p.id) && !seen.has(p.id)) {
      seen.add(p.id);
      p = parentOf(p);
    }
    return p && !seen.has(p.id) ? p : null;
  };
  /** Entities in tree order: each after its parent. */
  const ordered: HbEntity[] = [];
  {
    const visited = new Set<string>();
    const visit = (e: HbEntity) => {
      if (visited.has(e.id)) return;
      visited.add(e.id);
      ordered.push(e);
      for (const c of children.get(e.id) ?? []) visit(c);
    };
    for (const e of entities) if (!parentOf(e)) visit(e);
    for (const e of entities) visit(e); // anything left in a cycle
  }
  const plannedThings = ordered.filter((e) => !skipped.has(e.id) && !isPlace(e));
  const holds = new Set<string>();
  for (const e of plannedThings) {
    const p = keptParent(e);
    if (p && !isPlace(p)) holds.add(p.id);
  }

  // --- legacy codes -----------------------------------------------------------------------------
  const codesOf = (e: HbEntity): string[] => {
    const out: string[] = [];
    const asset = homeboxAssetCode(e.asset_id);
    for (const raw of [asset, e.id]) {
      if (!raw) continue;
      const code = legacyCodeOf(raw);
      if (look.takenCodes.has(code)) {
        report.issue(entityRef(e), 'code_taken', { column: raw === e.id ? 'id' : 'asset_id' });
        continue;
      }
      out.push(code);
    }
    return out;
  };

  // --- types ------------------------------------------------------------------------------------
  const typeStates = new Map<string, TypeState>();
  const typeState = (t: HbEntityType): TypeState => {
    const known = typeStates.get(t.id);
    if (known) return known;
    const key = `type:${t.id}`;
    const choice = choices.types[t.id];
    const name = (choice && 'create' in choice ? choice.create : t.name).trim();
    const candidates = [
      look.sourceIds.get(key),
      choice && 'typeId' in choice ? choice.typeId.toLowerCase() : undefined,
      look.types.get(normalize(name)),
    ];
    const existing = candidates.find((id) => id && look.typeInfo.has(id));
    let state: TypeState;
    if (existing) {
      const info = look.typeInfo.get(existing);
      state = {
        op: {
          op: 'type',
          key,
          name: t.name,
          target: { id: existing },
          customise: false,
          container: false,
          fields: [],
        },
        fields: (info?.fields ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          usable: !f.secret && !f.archived,
        })),
        caps: info?.caps ?? [],
        used: new Set((info?.fields ?? []).map((f) => f.key)),
        created: false,
        emitted: false,
      };
    } else {
      const icon = keptIcon(t.icon);
      if (icon.dropped) {
        report.issue({ kind: 'entity', id: t.id, name: t.name }, 'hb_icon_dropped');
      }
      state = {
        op: {
          op: 'type',
          key,
          name: t.name,
          target: { create: { name: (name || t.name).slice(0, TYPE_NAME_MAX), icon: icon.icon } },
          customise: false,
          container: false,
          fields: [],
        },
        fields: [],
        caps: [],
        used: new Set(),
        created: true,
        emitted: false,
      };
    }
    typeStates.set(t.id, state);
    return state;
  };
  /** The type's field for `label` and Kept kind `kind`: its key, `wrong-kind`, or none. */
  const fieldFor = (state: TypeState, label: string, kind: string) => {
    const want = normalize(label);
    const match = state.fields.find(
      (f) => normalize(f.label) === want || normalize(f.key.replaceAll('_', ' ')) === want,
    );
    if (!match) return null;
    return match.usable && match.kind === kind ? match.key : 'wrong-kind';
  };
  const addField = (state: TypeState, label: string, kind: string): string => {
    const clean = label.trim().slice(0, FIELD_LABEL_MAX);
    const key = fieldKey(clean, state.used);
    state.op.fields.push({
      sourceKey: `field:${state.op.key.slice(5)}:${normalize(clean).slice(0, 120)}`,
      key,
      label: clean,
      kind,
    });
    state.fields.push({ key, label: clean, kind, usable: true });
    if ('id' in state.op.target && look.typeInfo.get(state.op.target.id)?.builtin) {
      state.op.customise = true;
    }
    return key;
  };

  // --- tags -------------------------------------------------------------------------------------
  const tagOps = new Map<string, TagOp>();
  const tagRefs = new Map<string, Ref>();
  for (const t of data.tags.values()) {
    if (choices.seeded === 'skip_unused' && seeded.tags.has(t.id)) {
      report.issue({ kind: 'entity', id: t.id, name: t.name }, 'hb_seeded_skipped', {
        status: 'skipped',
      });
      continue;
    }
    const key = `tag:${t.id}`;
    const name = t.name.trim();
    if (!name || name.length > LIMITS.tag) {
      report.issue({ kind: 'entity', id: t.id, name: t.name }, 'tag_not_added', {
        status: 'skipped',
        params: { max: LIMITS.tag },
      });
      continue;
    }
    tagRefs.set(t.id, { key });
    if (done(key)) continue;
    const existing = look.tags.get(normalize(name));
    const op: TagOp = existing
      ? { op: 'tag', key, target: { id: existing } }
      : { op: 'tag', key, target: { create: { name, colour: colourOf(t.color) } } };
    tagOps.set(t.id, op);
  }
  /** A tag and every ancestor tag (flattened, D146). */
  const withAncestors = (tagId: string): string[] => {
    const out: string[] = [];
    let cur = data.tags.get(tagId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur.id);
      cur = cur.tag_children ? data.tags.get(cur.tag_children) : undefined;
    }
    return out;
  };
  const tagsOfEntity = new Map<string, string[]>();
  for (const te of data.tagEntities) {
    const list = tagsOfEntity.get(te.entity_id) ?? [];
    list.push(te.tag_id);
    tagsOfEntity.set(te.entity_id, list);
  }
  const usedTags = new Set<string>();
  let archivedTagUsed = false;

  // --- places -----------------------------------------------------------------------------------
  const placeIdOfKey = new Map<string, string>(); // planned place key → existing id when matched
  for (const e of ordered) {
    if (skipped.has(e.id) || !isPlace(e)) continue;
    if (done(e.id)) continue;
    const parent = keptParent(e);
    const parentRef: Ref | null = parent ? { key: parent.id } : null;
    const parentId = parent
      ? (look.sourceIds.get(parent.id) ?? placeIdOfKey.get(parent.id) ?? null)
      : null;
    const canMatch = !parent || parentId !== null;
    const name = e.name.trim().slice(0, 120);
    const existingId = canMatch
      ? (look.places.get(parentId ?? '')?.get(normalize(name)) ?? null)
      : null;
    if (existingId) placeIdOfKey.set(e.id, existingId);
    const codes = codesOf(e);
    ops.places.push({ op: 'place', key: e.id, name, parent: parentRef, existingId, codes });
    if (!existingId) summary.places += 1;
    summary.legacyCodes += codes.length;
  }

  // --- things -----------------------------------------------------------------------------------
  const fieldsOf = new Map<string, HbEntityField[]>();
  for (const f of data.fields) {
    const list = fieldsOf.get(f.entity_fields) ?? [];
    list.push(f);
    fieldsOf.set(f.entity_fields, list);
  }
  const maintenanceOf = new Map<string, typeof data.maintenance>();
  for (const m of data.maintenance) {
    const list = maintenanceOf.get(m.entity_id) ?? [];
    list.push(m);
    maintenanceOf.set(m.entity_id, list);
  }
  const warrantyKeys = new Set<string>();
  const purchaseKeys = new Set<string>();
  const schedulesOn = look.modules.has('schedules');

  for (const e of plannedThings) {
    const ref = entityRef(e);
    if (done(e.id)) continue;
    const extra: string[] = [];
    let asText = false;
    const text = (line: string) => {
      extra.push(line);
      asText = true;
    };

    // Where it goes.
    const parent = keptParent(e);
    const where: ThingOp['where'] = !parent
      ? { place: { id: look.unplacedId } }
      : isPlace(parent)
        ? { place: { key: parent.id } }
        : { container: { key: parent.id } };

    // Its type.
    const locationInItem = isLocation(data, e);
    const hbType = data.types.get(e.entity_type_entities);
    let state: TypeState | null = null;
    let type: Ref | null = null;
    let caps: string[] = [];
    if (locationInItem) {
      report.issue(ref, 'hb_location_in_item');
      if (look.boxBinTypeId) {
        type = { id: look.boxBinTypeId };
        caps = look.typeInfo.get(look.boxBinTypeId)?.caps ?? ['container'];
      }
    } else if (hbType) {
      state = typeState(hbType);
      if (holds.has(e.id) && !state.caps.includes('container')) {
        if (state.created) state.op.container = true;
        else if (look.boxBinTypeId) {
          // The mapped type can't hold things: a box, its Homebox type kept in the notes.
          text(`Homebox type: ${hbType.name}`);
          type = { id: look.boxBinTypeId };
          caps = look.typeInfo.get(look.boxBinTypeId)?.caps ?? ['container'];
          state = null;
        }
      }
      if (state) {
        state.emitted = true;
        type = { key: state.op.key };
        caps = [...state.caps, ...(state.op.container ? ['container'] : [])];
      }
    }
    if (holds.has(e.id)) summary.containers += 1;

    // Name, brand, model, serial.
    let name = e.name.trim();
    if (name.length > LIMITS.name) {
      text(`Name: ${name}`);
      report.issue(ref, 'too_long', {
        status: 'text',
        column: 'name',
        params: { max: LIMITS.name },
      });
      name = name.slice(0, LIMITS.name);
    }
    let brand: NameRef | null = null;
    if (e.manufacturer) {
      if (e.manufacturer.length > LIMITS.brand) {
        text(`Manufacturer: ${e.manufacturer}`);
        report.issue(ref, 'brand_too_long', {
          status: 'text',
          column: 'manufacturer',
          params: { max: LIMITS.brand },
        });
      } else {
        const id = look.brands.get(normalize(e.manufacturer));
        brand = id ? { id } : { create: e.manufacturer };
      }
    }
    let model: string | null = e.model_number || null;
    if (model && model.length > LIMITS.model) {
      text(`Model: ${model}`);
      report.issue(ref, 'too_long', {
        status: 'text',
        column: 'model_number',
        params: { max: LIMITS.model },
      });
      model = null;
    }
    let serial: string | null = e.serial_number || null;
    if (serial && serial.length > LIMITS.serial) {
      text(`Serial: ${serial}`);
      report.issue(ref, 'too_long', {
        status: 'text',
        column: 'serial_number',
        params: { max: LIMITS.serial },
      });
      serial = null;
    }

    // Quantity (D10, D183).
    let quantity = Math.round(e.quantity * 1000) / 1000;
    if (quantity <= 0) {
      quantity = 1;
      report.issue(ref, 'hb_quantity_zero');
    }
    const oneByOne = caps.includes('serialized') || caps.includes('metered');
    if (quantity !== 1 && oneByOne) {
      text(`Quantity in Homebox: ${e.quantity}`);
      report.issue(ref, 'hb_quantity_rounded', { status: 'text', column: 'quantity' });
      quantity = 1;
    }

    // Tags, flattened; "Archived in Homebox" when chosen.
    const tagIds = new Set<string>();
    for (const t of tagsOfEntity.get(e.id) ?? []) for (const a of withAncestors(t)) tagIds.add(a);
    const tags: Ref[] = [];
    for (const t of tagIds) {
      const tagRef = tagRefs.get(t);
      if (!tagRef) continue;
      if (tags.length >= TAGS_MAX) {
        report.issue(ref, 'tag_not_added', { params: { max: TAGS_MAX } });
        break;
      }
      tags.push(tagRef);
      usedTags.add(t);
    }
    if (e.archived && choices.archived === 'tag') {
      tags.push({ key: 'tag:archived' });
      archivedTagUsed = true;
    }

    // Custom fields, and insured.
    const custom: Record<string, unknown> = {};
    let integer = false;
    for (const f of fieldsOf.get(e.id) ?? []) {
      const label = f.name.trim();
      if (!label) continue;
      const kind = HB_FIELD_KIND[f.type];
      let value: unknown;
      if (f.type === 'text') value = f.text_value || undefined;
      else if (f.type === 'number') value = f.number_value ?? undefined;
      else if (f.type === 'boolean') value = f.boolean_value;
      else {
        const gap = Math.abs(Date.parse(f.time_value) - Date.parse(f.created_at));
        if (gap <= 1000) {
          report.issue(ref, 'hb_time_default', { column: label });
          value = undefined;
        } else value = hbDate(f.time_value) ?? undefined;
      }
      if (value === undefined) continue;
      if (f.type === 'number') integer = true;
      const shown = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
      const asNotes = (code?: ImportIssueCode) => {
        text(`${label}: ${shown}`);
        if (code) report.issue(ref, code, { status: 'text', column: label });
      };
      if (!state) {
        asNotes();
        continue;
      }
      if (f.type === 'text' && String(value).length > TEXT_MAX) {
        asNotes('too_long');
        continue;
      }
      let key = fieldFor(state, label, kind);
      if (key === 'wrong-kind') {
        asNotes('not_type_field');
        continue;
      }
      if (!key) {
        if ((choices.fields[label] ?? 'add_to_type') === 'notes') {
          asNotes();
          continue;
        }
        key = addField(state, label, kind);
      }
      if (
        !fieldValueSchema({
          kind: kind as 'text',
          options: undefined,
          repeatable: false,
        }).safeParse(value).success
      ) {
        asNotes('not_field_value');
        continue;
      }
      custom[key] = value;
    }
    if (integer) report.issue(ref, 'hb_number_integer');
    if (e.insured && choices.insured === 'field') {
      if (state) {
        let key = fieldFor(state, INSURED_LABEL, 'boolean');
        if (key === 'wrong-kind') key = null;
        custom[key ?? addField(state, INSURED_LABEL, 'boolean')] = true;
      } else text(`${INSURED_LABEL}: yes`);
    }

    // The purchase (D115), in the chosen currency.
    const bought = hbDate(e.purchase_date);
    const price = e.purchase_price > 0 ? amountOf(e.purchase_price) : null;
    let purchase: ThingOp['purchase'] = null;
    const purchaseText = () =>
      [
        bought ? `Purchased: ${bought}` : null,
        e.purchase_from ? `From: ${e.purchase_from}` : null,
        price ? `Price: ${price} ${currency}` : null,
      ]
        .filter(Boolean)
        .join(', ');
    if (bought || price || e.purchase_from) {
      const why: ImportIssueCode | null = !bought
        ? price
          ? 'needs_date'
          : null
        : !price
          ? 'needs_price'
          : bought > look.today
            ? 'future_date'
            : moneyBlock;
      if (bought && price && !why) {
        let vendor: NameRef | null = null;
        if (e.purchase_from) {
          if (e.purchase_from.length > LIMITS.vendor) {
            text(`From: ${e.purchase_from}`);
            report.issue(ref, 'vendor_too_long', {
              status: 'text',
              column: 'purchase_from',
              params: { max: LIMITS.vendor },
            });
          } else {
            const id = look.vendors.get(normalize(e.purchase_from));
            vendor = id ? { id } : { create: e.purchase_from };
          }
        }
        purchase = { key: `${e.id}:purchase`, purchasedOn: bought, price, currency, vendor };
        purchaseKeys.add(e.id);
        summary.purchases += 1;
      } else {
        text(purchaseText());
        if (why) report.issue(ref, why, { status: 'text', column: 'purchase_price' });
      }
    }

    // The warranty, from the purchase date.
    const expires = hbDate(e.warranty_expires);
    if (e.lifetime_warranty || expires) {
      const warrantyText = e.lifetime_warranty
        ? 'Warranty: lifetime'
        : `Warranty until: ${expires}`;
      const can =
        look.modules.has('warranties') &&
        quantity === 1 &&
        bought !== null &&
        (e.lifetime_warranty || (expires !== null && expires >= bought));
      if (can && bought) {
        ops.warranties.push({
          op: 'warranty',
          key: `${e.id}:warranty`,
          thing: { key: e.id },
          body: e.lifetime_warranty
            ? { kind: 'manufacturer', startsOn: bought, lifetime: true }
            : { kind: 'manufacturer', startsOn: bought, endsOn: expires as string },
        });
        warrantyKeys.add(e.id);
        summary.warranties += 1;
      } else {
        text(warrantyText);
        report.issue(ref, 'hb_needs_module', { status: 'text', column: 'warranty_expires' });
      }
    }
    if (e.warranty_details) extra.push(`Warranty: ${e.warranty_details}`);

    // Sold.
    let sold: ThingOp['sold'] = null;
    const soldOn = hbDate(e.sold_date);
    if (soldOn || e.sold_to || e.sold_price > 0) {
      sold = {};
      if (soldOn && soldOn <= look.today) sold.endedOn = soldOn;
      if (e.sold_to) {
        if (e.sold_to.length > 200) text(`Sold to: ${e.sold_to}`);
        else sold.endedTo = e.sold_to;
      }
      if (e.sold_notes) sold.endedNotes = e.sold_notes.slice(0, NOTES_MAX);
      if (e.sold_price > 0) {
        if (moneyBlock) {
          text(`Sold for: ${amountOf(e.sold_price)} ${currency}`);
          report.issue(ref, moneyBlock, { status: 'text', column: 'sold_price' });
        } else {
          sold.endedPrice = amountOf(e.sold_price);
          sold.endedCurrency = currency;
        }
      }
    }

    // Maintenance whose records can't be made here: its text in the notes.
    for (const m of maintenanceOf.get(e.id) ?? []) {
      if (!schedulesOn) {
        text(maintenanceText(m, currency));
        report.issue({ kind: 'maintenance', id: m.id, name: m.name }, 'hb_needs_module', {
          status: 'text',
        });
      }
    }

    // Notes: description, a blank line, then notes; then what was kept as text.
    let notes = [e.description, e.notes].filter(Boolean).join('\n\n');
    if (extra.length > 0) notes = [notes, extra.join('\n')].filter(Boolean).join('\n\n');
    if (notes.length > NOTES_MAX) {
      notes = notes.slice(0, NOTES_MAX);
      report.issue(ref, 'notes_cut', { params: { max: NOTES_MAX } });
    }

    const codes = codesOf(e);
    summary.legacyCodes += codes.length;
    ops.things.push({
      op: 'thing',
      key: e.id,
      name,
      where,
      type,
      quantity,
      brand,
      model,
      serial,
      notes: notes || null,
      tags,
      custom,
      purchase,
      sold,
      codes,
    });
    summary.things += 1;
    if (asText) {
      report.text(ref);
      summary.asText += 1;
    }
  }

  // --- attachments ------------------------------------------------------------------------------
  const ownerOf = (entityId: string | null): AttachmentOp['owner'] | null => {
    const e = entityId ? data.entities.get(entityId) : undefined;
    if (!e || skipped.has(e.id)) return null;
    return isPlace(e) ? { place: { key: e.id } } : { thing: { key: e.id } };
  };
  const firstPhoto = new Set<string>();
  const attachments = [...data.attachments].sort((a, b) => Number(b.primary) - Number(a.primary));
  for (const a of attachments) {
    if (a.type === 'thumbnail') continue;
    const owner = ownerOf(a.entity_attachments);
    if (!owner || done(a.id)) continue;
    const ref: ImportIssueRef = { kind: 'attachment', id: a.id, name: a.title };
    const entity = a.entity_attachments as string;
    let role = ROLE[a.type] ?? 'document';
    if (role === 'receipt' && !look.showMoney) role = 'document';
    const subject: AttachmentOp['subject'] =
      a.type === 'warranty' && warrantyKeys.has(entity)
        ? 'warranty'
        : a.type === 'receipt' && role === 'receipt' && purchaseKeys.has(entity)
          ? 'purchase'
          : 'owner';
    let sort = 1;
    if (a.type === 'photo' && !firstPhoto.has(entity)) {
      firstPhoto.add(entity);
      sort = 0;
    }
    const base = { op: 'attachment' as const, key: a.id, owner, subject, role, sort };
    if (a.mime_type === 'link/url') {
      const url = a.path.trim();
      if (!isHttp(url) || url.length > URL_MAX) {
        report.issue(ref, 'not_link', { status: 'skipped' });
        continue;
      }
      ops.attachments.push({ ...base, title: a.title, file: null, url });
      summary.links += 1;
      continue;
    }
    const refused = attachmentProblem(a, data, look.maxFileBytes);
    if (refused) {
      report.issue(ref, refused, {
        status: 'skipped',
        ...(refused === 'file_type_refused' ? { params: { kind: a.mime_type.slice(0, 100) } } : {}),
        ...(refused === 'file_too_large' ? { params: { max: look.maxFileBytes } } : {}),
      });
      if (refused !== 'file_missing') summary.refusedFiles += 1;
      continue;
    }
    ops.attachments.push({
      ...base,
      title: a.title,
      file: {
        entry: attachmentEntry(a.id),
        mime: a.mime_type,
        bytes: data.files.get(a.id) ?? 0,
      },
      url: null,
    });
    summary.attachments += 1;
  }

  // --- maintenance ------------------------------------------------------------------------------
  if (schedulesOn) {
    for (const m of data.maintenance) {
      const owner = ownerOf(m.entity_id);
      if (!owner || done(m.id)) continue;
      const ref: ImportIssueRef = { kind: 'maintenance', id: m.id, name: m.name };
      const doneOn = hbDate(m.date);
      const dueOn = hbDate(m.scheduled_date);
      const name = m.name.trim().slice(0, 200) || 'Maintenance';
      if (doneOn && doneOn <= look.today) {
        let notes = [name, m.description].filter(Boolean).join('\n\n');
        let total: string | null = null;
        if (m.cost > 0) {
          if (moneyBlock) {
            notes = `${notes}\nCost: ${amountOf(m.cost)} ${currency}`;
            report.issue(ref, moneyBlock, { status: 'text', column: 'cost' });
          } else total = amountOf(m.cost);
        }
        ops.maintenance.push({
          op: 'service',
          key: m.id,
          owner,
          servicedOn: doneOn,
          notes: notes.slice(0, NOTES_MAX),
          total,
          currency: total ? currency : null,
        });
        summary.services += 1;
      } else if (dueOn || doneOn) {
        ops.maintenance.push({
          op: 'schedule',
          key: m.id,
          owner,
          name,
          dueOn: (dueOn ?? doneOn) as string,
        });
        summary.schedules += 1;
      } else {
        report.issue(ref, 'needs_date', { status: 'skipped' });
      }
    }
  }

  // --- templates (best effort) ------------------------------------------------------------------
  const templateFields = new Map<string, typeof data.templateFields>();
  for (const f of data.templateFields) {
    const list = templateFields.get(f.entity_template_fields) ?? [];
    list.push(f);
    templateFields.set(f.entity_template_fields, list);
  }
  for (const tpl of data.templates) {
    if (done(tpl.id)) continue;
    const ref: ImportIssueRef = { kind: 'template', id: tpl.id, name: tpl.name };
    const name = tpl.name.trim().slice(0, TYPE_NAME_MAX);
    if (!name) {
      report.issue(ref, 'no_name', { status: 'skipped' });
      continue;
    }
    const lines: string[] = [];
    for (const f of templateFields.get(tpl.id) ?? []) {
      const value =
        f.type === 'text'
          ? f.text_value
          : f.type === 'number'
            ? f.number_value === null
              ? ''
              : String(f.number_value)
            : f.type === 'boolean'
              ? f.boolean_value
                ? 'yes'
                : ''
              : '';
      if (value) lines.push(`${f.name}: ${value}`);
    }
    const notes = [tpl.default_description, lines.join('\n')].filter(Boolean).join('\n\n');
    const partial =
      tpl.include_purchase_fields ||
      tpl.include_sold_fields ||
      tpl.include_warranty_fields ||
      tpl.default_insured ||
      tpl.default_lifetime_warranty ||
      !!tpl.default_warranty_details ||
      !!tpl.entity_template_location;
    if (partial) report.issue(ref, 'hb_template_partial');
    const tagsOfTpl: Ref[] = [];
    for (const t of templateTagIds(tpl)) {
      for (const a of withAncestors(t)) {
        const r = tagRefs.get(a);
        if (r && !tagsOfTpl.some((x) => 'key' in x && 'key' in r && x.key === r.key)) {
          tagsOfTpl.push(r);
          usedTags.add(a);
        }
      }
    }
    const manufacturer = tpl.default_manufacturer;
    const brand: NameRef | null =
      manufacturer && manufacturer.length <= LIMITS.brand
        ? look.brands.get(normalize(manufacturer))
          ? { id: look.brands.get(normalize(manufacturer)) as string }
          : { create: manufacturer }
        : null;
    ops.templates.push({
      op: 'template',
      key: tpl.id,
      name,
      payload: {
        ...(tpl.default_name ? { name: tpl.default_name.slice(0, LIMITS.name) } : {}),
        ...(tpl.default_model_number
          ? { model: tpl.default_model_number.slice(0, LIMITS.model) }
          : {}),
        ...(tpl.default_quantity > 0
          ? { quantity: Math.round(tpl.default_quantity * 1000) / 1000 }
          : {}),
        ...(notes ? { notes: notes.slice(0, NOTES_MAX) } : {}),
        tags: tagsOfTpl,
        brand,
      },
    });
  }

  // --- types and tags the plan uses -------------------------------------------------------------
  for (const state of typeStates.values()) {
    if (!state.emitted || done(state.op.key)) {
      // Done earlier: only fields added since then are new work.
      if (state.emitted && state.op.fields.length > 0) {
        ops.types.push(state.op);
        summary.fieldsAdded += state.op.fields.length;
      }
      continue;
    }
    ops.types.push(state.op);
    if ('create' in state.op.target) summary.types += 1;
    summary.fieldsAdded += state.op.fields.length;
  }
  for (const op of tagOps.values()) {
    ops.tags.push(op);
    if ('create' in op.target) summary.tags += 1;
  }
  if (archivedTagUsed && !done('tag:archived')) {
    const existing = look.tags.get(normalize(ARCHIVED_TAG));
    ops.tags.push({
      op: 'tag',
      key: 'tag:archived',
      target: existing ? { id: existing } : { create: { name: ARCHIVED_TAG, colour: null } },
    });
    if (!existing) summary.tags += 1;
  }

  summary.skipped = [...report.rows.values()].filter(
    (r) => r.status === 'skipped' && r.ref.kind === 'entity' && data.entities.has(r.ref.id),
  ).length;

  return {
    ops: [
      ...ops.types,
      ...ops.tags,
      ...ops.places,
      ...ops.things,
      ...ops.warranties,
      ...ops.attachments,
      ...ops.maintenance,
      ...ops.templates,
    ],
    report: {
      source: 'homebox_zip',
      summary,
      rows: [...report.rows.values()].filter((r) => r.issues.length > 0),
    },
  };
}

/** A maintenance entry as a line of notes. */
function maintenanceText(m: HomeboxData['maintenance'][number], currency: string): string {
  const doneOn = hbDate(m.date);
  const dueOn = hbDate(m.scheduled_date);
  return [
    `Maintenance: ${m.name}`,
    doneOn ? `done ${doneOn}` : null,
    dueOn ? `due ${dueOn}` : null,
    m.cost > 0 ? `${amountOf(m.cost)} ${currency}` : null,
    m.description || null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Why a file attachment can't come across, before its bytes are read (its type as Homebox
 * sniffed it, its declared size); the job sniffs the bytes again (D157). */
function attachmentProblem(
  a: HbAttachment,
  data: HomeboxData,
  maxFileBytes: number,
): ImportIssueCode | null {
  if (!data.files.has(a.id)) return 'file_missing';
  const mime = a.mime_type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!KEPT_MIMES.has(mime)) return 'file_type_refused';
  if ((data.files.get(a.id) ?? 0) > maxFileBytes) return 'file_too_large';
  return null;
}
