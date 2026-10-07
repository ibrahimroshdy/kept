/**
 * The step-2 web ↔ server contract: the request and response shapes of every inventory route,
 * written from the Phase B route tables of docs/plans/2026-09-26-step-2-core-inventory.md
 * (tasks 11–22). The server tasks implement exactly these shapes; if one has to differ, this file
 * changes with it, in the same commit.
 *
 * Conventions (plan, "API conventions"): JSON is camelCase; money is a decimal **string** with a
 * `currency`; times are ISO 8601 strings and calendar dates `YYYY-MM-DD`; ids are UUIDv7 strings
 * the client may choose (`id?` on a create); every PATCH, and every POST that changes a versioned
 * row, sends `If-Match: <rowVersion>`. Lists are `{items, next_cursor}` (the server's `pageOf()`).
 * A money field the caller may not see is **omitted** (never null), so every money field below is
 * optional: `serialize/gates.ts` decides.
 *
 * The domain unions below mirror `packages/shared/src/inventory.ts` (task 1) value for value.
 * They are written out here so the web contract doesn't wait for task 1; once it lands they can
 * be re-exported from `@kept/shared` without changing a single use.
 */

import type {
  ActiveSourceType,
  LedgerTask,
  ListSurface,
  LoanDirection,
  SavedListQuery,
  DerivedState as SharedDerivedState,
  ValuationSource,
} from '@kept/shared';
import type { AiCallSummary } from '../capture/types';

// ----- shared shapes ---------------------------------------------------------------------------

/** One page of a list-standard route (`pageOf()` in apps/server/src/http/conventions.ts). */
export type Page<T> = { items: T[]; next_cursor: string | null };

/** A decimal string (the canonical `parseAmount` form, e.g. "1234.5") and an ISO 4217 code. */
export type Money = { amount: string; currency: string };

/**
 * A list filter's values (D205): one, or several (sent as a repeated key, any of them matches).
 * A list's `not` names the filters that exclude their values instead ("is none of").
 */
export type Many<T extends string = string> = T | T[];

/** Who did something, as every history and list row shows them. */
export type ActorRef = { displayName: string };

// ----- domain values (mirror @kept/shared inventory.ts, task 1) --------------------------------

/** D119, D158, §7.13. `ENDED` is every value except `in_use`. */
export type Lifecycle =
  | 'in_use'
  | 'sold'
  | 'given_away'
  | 'lost'
  | 'disposed'
  | 'stolen'
  | 'destroyed'
  | 'returned_to_owner';
export type EndedLifecycle = Exclude<Lifecycle, 'in_use'>;

/** Q10. */
export type Condition = 'new' | 'good' | 'fair' | 'poor' | 'broken';

/** D76. */
export type LinkKind =
  | 'accessory_of'
  | 'spare_part_for'
  | 'consumable_for'
  | 'bundled_with'
  | 'replaces'
  | 'related';

export type AttachmentRole =
  | 'photo'
  | 'receipt'
  | 'invoice'
  | 'manual'
  | 'warranty_doc'
  | 'proof'
  | 'condition_out'
  | 'condition_in'
  | 'registration'
  | 'document';

/** `files.class` (engineering spec §1.5). */
export type FileClass = 'evidence' | 'photo' | 'document' | 'video';

/** `vendors.kind` (engineering spec §1.4). */
export type VendorKind = 'store' | 'online' | 'service_centre' | 'station' | 'other';

/** "secret" is a flag on a field, never a kind (Q3). */
export type FieldKind =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'boolean'
  | 'url'
  | 'money'
  | 'person'
  | 'vendor'
  | 'file';

export type Capability =
  | 'container'
  | 'metered'
  | 'warranty'
  | 'serialized'
  | 'consumable'
  | 'expires';

/** D33. Account place kinds add their own keys. */
export type BuiltinPlaceKind = 'floor' | 'room' | 'zone' | 'closet';

/**
 * A thing's derived states (D119): step 2's uncertain, draft and ended, and step 4's lent and
 * borrowed (an open loan out or in, D56, D57) and in repair (a claim in repair, D54).
 */
export type DerivedState = SharedDerivedState;

/** A built-in type or place-kind icon: `lucide:<name>`, `tabler:<name>` or `kept:<name>` (D98). */
export type IconRef = string;

// ----- types, fields and place kinds (task 11) -------------------------------------------------

/** GET /api/v1/accounts: the account switcher (Q21). */
export type AccountSummary = {
  id: string;
  ownerDisplayName: string;
  isOwn: boolean;
  canManage: boolean;
};
export type AccountsResponse = { accounts: AccountSummary[] };

export type DefaultMeter = { kind: string; unit: string };

/** One node of GET /api/v1/accounts/:accountId/types (a flat list; the tree is `parentId`). */
export type TypeNode = {
  id: string;
  parentId: string | null;
  /** Set on built-ins (D154, D192) and on the account's customised copies of them. */
  builtinKey: string | null;
  /** Null ⇒ translate `builtinKey` from the shared built-in library. */
  name: string | null;
  icon: IconRef;
  colour: string | null;
  /** The type's own capabilities. */
  capabilities: Capability[];
  /** Own plus inherited (through parents and field groups). */
  resolvedCapabilities: Capability[];
  /** The D192 Device group is a type with this set (Q4). */
  isFieldGroup: boolean;
  /** Ids of field-group types this type pulls fields from. */
  fieldGroups: string[];
  /** Set when this is an account's customised copy of a built-in (Q13b). */
  copiedFromId: string | null;
  /** Things using it, counted in the caller's visible locations only. */
  inUse: number;
  rowVersion: number;
  archivedAt?: string | null;
};
export type TypesResponse = { types: TypeNode[] };

export type ResolvedField = {
  id: string;
  key: string;
  /** Null ⇒ translate `labelKey` (built-in fields). */
  label: string | null;
  labelKey: string | null;
  kind: FieldKind;
  unit: string | null;
  options: string[] | null;
  repeatable: boolean;
  required: boolean;
  secret: boolean;
  sort: number;
  archivedAt: string | null;
  source: { typeId: string; via: 'own' | 'inherited' | 'group' };
  /** For `PATCH /type-fields/:id`'s If-Match (T28 contract decision 3; the server requires it). */
  rowVersion: number;
};

/** GET /api/v1/types/:id. */
export type TypeDetail = TypeNode & {
  fields: ResolvedField[];
  defaultMeter?: DefaultMeter | null;
  defaultWarrantyMonths?: number | null;
};

export type CreateTypeBody = {
  id?: string;
  parentId: string | null;
  name: string;
  icon: IconRef;
  colour?: string;
  capabilities: Capability[];
  fieldGroups?: string[];
  defaultMeter?: DefaultMeter;
};

/** PATCH /api/v1/types/:id (If-Match), and the same body for POST …/preview. */
export type UpdateTypeBody = {
  name?: string;
  icon?: IconRef;
  colour?: string | null;
  capabilities?: Capability[];
  parentId?: string | null;
  fieldGroups?: string[];
  defaultWarrantyMonths?: number | null;
};

/** POST /api/v1/types/:id/preview (read-only; `kept.type_impact`, D92, D123). */
export type TypeImpact = {
  /** `name` null ⇒ translate `builtinKey` (T28 contract decision 4). */
  descendants: { id: string; name: string | null; builtinKey: string | null }[];
  /** One row per visible location; `locationId` null for account-level rows. */
  perLocation: { locationId: string | null; name: string | null; things: number }[];
  /** Locations the caller can't see, as a count only. */
  hiddenLocations: number;
  fieldsToArchive: string[];
};

/** POST /api/v1/types/:id/fields → 201 ResolvedField. `secret` only at creation, owner only (D177). */
export type CreateTypeFieldBody = {
  key: string;
  label: string;
  kind: FieldKind;
  unit?: string;
  options?: string[];
  repeatable?: boolean;
  required?: boolean;
  secret?: boolean;
};

/** PATCH /api/v1/type-fields/:id (If-Match). "Required" applies to new edits only (D172). */
export type UpdateTypeFieldBody = {
  label?: string;
  unit?: string | null;
  options?: string[] | null;
  required?: boolean;
  sort?: number;
};

/** POST /api/v1/types/:id/customise `{accountId}` → `{typeId}`. */
export type CustomiseTypeBody = { accountId: string };
export type CustomiseTypeResult = { typeId: string };

/** POST /api/v1/{types|places|brands|vendors|people|tags}/:id/merge-into. */
export type MergeIntoBody = { targetId: string };
export type MergeTypeResult = { repointed: number };
/** POST /api/v1/places/:id/merge-into: `If-Match` is the target's version (T25 decision 5). */
export type MergePlaceBody = MergeIntoBody & { sourceRowVersion: number };

export type PlaceKindNode = {
  id: string;
  /** Built-in keys (D33) or the account's own. */
  key: string;
  builtinKey: BuiltinPlaceKind | null;
  /**
   * Null for a built-in, shared by everyone and read-only; else the account whose own kind it is.
   * An account's customised copy of a built-in keeps the built-in's `builtinKey`.
   */
  ownerAccountId: string | null;
  name: string | null;
  icon: IconRef;
  fields: ResolvedField[];
  rowVersion: number;
  archivedAt?: string | null;
};
export type PlaceKindsResponse = { placeKinds: PlaceKindNode[] };
export type CreatePlaceKindBody = { id?: string; key: string; name: string; icon: IconRef };
export type UpdatePlaceKindBody = { name?: string; icon?: IconRef };
/** POST /api/v1/place-kinds/:id/fields: the type-field shape (D160). */
export type CreatePlaceKindFieldBody = CreateTypeFieldBody;
/** POST /api/v1/accounts/:accountId/place-kinds/:builtinKey/customise (T28 decision 7). */
export type CustomisePlaceKindResult = { placeKindId: string };

// ----- registries: brands, vendors, people, tags (task 11) -------------------------------------

export type Brand = {
  id: string;
  /** Null for a built-in brand. */
  ownerAccountId: string | null;
  name: string;
  website: string | null;
  supportPhone: string | null;
  claimUrl: string | null;
  defaultWarrantyMonths: number | null;
  rowVersion: number;
  /** Whether `GET /brands/:id/logo` has an image: sent by `GET /brands/:id` only (the server's
   * registries/view.ts), so the brand page asks for no logo it would get a 404 for. */
  hasLogo?: boolean;
};
export type Vendor = {
  id: string;
  ownerAccountId: string;
  name: string;
  kind: VendorKind;
  address: string | null;
  phone: string | null;
  website: string | null;
  rowVersion: number;
};
export type Person = {
  id: string;
  ownerAccountId: string;
  displayName: string;
  /** Set when the person is also a Kept user. */
  userId: string | null;
  rowVersion: number;
};
export type Tag = {
  id: string;
  ownerAccountId: string;
  name: string;
  colour: string | null;
  rowVersion: number;
};

export type RegistryKind = 'brands' | 'vendors' | 'people' | 'tags';
export type RegistryItem = {
  brands: Brand;
  vendors: Vendor;
  people: Person;
  tags: Tag;
};

export type CreateBrandBody = {
  id?: string;
  name: string;
  website?: string;
  supportPhone?: string;
  claimUrl?: string;
  defaultWarrantyMonths?: number;
};
export type CreateVendorBody = {
  id?: string;
  name: string;
  kind?: VendorKind;
  address?: string;
  phone?: string;
  website?: string;
};
export type CreatePersonBody = { id?: string; displayName: string; userId?: string };
export type CreateTagBody = { id?: string; name: string; colour?: string };
export type CreateRegistryBody = {
  brands: CreateBrandBody;
  vendors: CreateVendorBody;
  people: CreatePersonBody;
  tags: CreateTagBody;
};

/**
 * POST /api/v1/accounts/:accountId/{brands|vendors|people|tags} → 201. The duplicates are a hint,
 * never a block (D11, similarity > 0.5). A normalised duplicate brand or tag is a 409 `conflict`
 * whose body carries `existingId`.
 */
export type CreateRegistryResult<K extends RegistryKind> = {
  item: RegistryItem[K];
  possibleDuplicates: { id: string; name: string; similarity: number }[];
};
export type RegistryConflictDetails = { existingId: string };

/**
 * A 409 from a type, field, place-kind or registry write (T28 contract decision 2): why, and
 * which key when a field is redefined. `in_use` answers with the `in_use` code.
 */
export type RegistryConflictReason = 'cycle' | 'field_redefined' | 'builtin' | 'in_use';
export type TypeConflictDetails = { reason?: RegistryConflictReason; key?: string };

/** PATCH /api/v1/{brands|vendors|people|tags}/:id (If-Match, admin). */
export type UpdateRegistryBody = {
  brands: Partial<Omit<CreateBrandBody, 'id'>>;
  vendors: Partial<Omit<CreateVendorBody, 'id'>>;
  people: Partial<Omit<CreatePersonBody, 'id' | 'userId'>>;
  tags: Partial<Omit<CreateTagBody, 'id'>>;
};
/** POST /api/v1/{brands|vendors|people|tags}/:id/merge-into → the rows repointed. */
export type MergeRegistryResult = { repointed: number };

/**
 * GET|PUT /api/v1/people/:id/contact (D177: 404 unless visible; audited as secret, Q5). A person
 * with no contact details yet answers 200 with every field null (T11), not 404.
 */
export type PersonContact = { phone?: string | null; email?: string | null; notes?: string | null };

// ----- currencies and purchases (task 12) ------------------------------------------------------

export type Currency = {
  code: string;
  name: string;
  minorUnits: number;
  symbol: string;
  enabled: boolean;
  /** Instance admins (`?all=1`): a location uses it, so it can't be switched off (D168). */
  inUse?: boolean;
};
/** GET /api/v1/currencies (`?all=1` for instance admins). */
export type CurrenciesResponse = { currencies: Currency[] };
/** PATCH /api/v1/admin/currencies/:code (D168). */
export type UpdateCurrencyBody = { enabled: boolean };
/** A refused switch-off: one of the five defaults, or a location uses it (409 `conflict`). */
export type CurrencyConflictDetails = { reason?: 'default' | 'in_use' };

export type PurchaseLineBody = {
  id?: string;
  description: string;
  quantity: number;
  unitPrice?: string;
  thingId?: string;
};
/** POST /api/v1/purchases → 201 PurchaseView. */
export type CreatePurchaseBody = {
  id?: string;
  locationId: string;
  vendorId?: string;
  /** `YYYY-MM-DD`, not in the future in the location's time zone. */
  purchasedOn: string;
  currency?: string;
  total?: string;
  tax?: string;
  notes?: string;
  lines: PurchaseLineBody[];
};
/** PATCH /api/v1/purchases/:id (If-Match). */
export type UpdatePurchaseBody = Partial<Omit<CreatePurchaseBody, 'id' | 'locationId'>>;

export type PurchaseView = {
  id: string;
  locationId: string;
  vendor: { id: string; name: string } | null;
  purchasedOn: string;
  currency: string | null;
  total?: string;
  tax?: string;
  /** The amounts were withheld from this caller (T26, T12); receipts go with them. */
  moneyHidden?: true;
  notes: string | null;
  lines: {
    id: string;
    description: string;
    quantity: number;
    unitPrice?: string;
    moneyHidden?: true;
    thing: { id: string; name: string } | null;
  }[];
  receipts: AttachmentView[];
  /** The lines don't reconcile with the total within ±1% (never an error; screens §7). */
  flagged: boolean;
  rowVersion: number;
};
/** POST /api/v1/purchase-lines/:id/link. */
export type LinkPurchaseLineBody = { thingId: string };

// ----- places (task 13) ------------------------------------------------------------------------

/** One node of GET /api/v1/locations/:locationId/places (the whole tree; trashed excluded). */
export type PlaceNode = {
  id: string;
  parentId: string | null;
  name: string;
  kindKey: string;
  icon: IconRef | null;
  sort: number;
  isUnplaced: boolean;
  /** The primary short ID: the place's `/p/<short-id>` address (D208); null until one exists. */
  shortCode: string | null;
  thingCount: number;
  childCount: number;
};
export type PlacesResponse = { places: PlaceNode[] };

/**
 * A step of a breadcrumb. `kind` tells a place from a container thing; `isUnplaced` marks the
 * location's Unplaced area, whose name the web localises (T25 decision 4).
 */
export type PathStep = {
  id: string;
  name: string;
  kind: 'place' | 'container';
  isUnplaced: boolean;
  /** The step's primary short ID, so a breadcrumb links by code (D208; step 4, T19). Null
   * before one is assigned; absent from the mock and older paths. */
  shortCode?: string | null;
};

export type SecretSummary = {
  fieldKey: string;
  label: string | null;
  /** A value is stored. */
  set: boolean;
  /** The field's policy lets the caller reveal it (D116, D177). */
  canReveal: boolean;
};

/** GET /api/v1/places/:id. */
export type PlaceView = {
  id: string;
  locationId: string;
  parentId: string | null;
  name: string;
  kindKey: string;
  icon: IconRef | null;
  isUnplaced: boolean;
  path: PathStep[];
  shortCode: string | null;
  fields: ResolvedField[];
  custom: Record<string, unknown>;
  secrets: SecretSummary[];
  counts: { places: number; things: number };
  attachments: AttachmentView[];
  rowVersion: number;
};

export type CreatePlaceBody = {
  id?: string;
  parentId?: string | null;
  /** 1–120 characters. */
  name: string;
  kindKey: string;
  icon?: IconRef;
};

/** PATCH /api/v1/places/:id (If-Match). Re-parenting stays within the location. */
export type UpdatePlaceBody = {
  name?: string;
  kindKey?: string;
  icon?: IconRef | null;
  sort?: number;
  /** Null ⇒ the top level of the location (T25 decision 2). */
  parentId?: string | null;
  custom?: Record<string, unknown | null>;
};

/** GET /api/v1/places/:id/contents: places first, then things (screens §5). */
export type PlaceContents = { places: PlaceNode[]; things: Page<ThingRow> };

export type MoveTarget = { placeId: string } | { containerId: string };

/** POST /api/v1/places/:id/trash and POST /api/v1/things/:id/trash. */
export type TrashBody = { contents?: 'move' | 'trash'; moveTo?: MoveTarget };
export type TrashResult = { trashed: string[]; moved: string[]; trashBatchId: string };
/** The body of a 409 `contents_choice_required` (D45, D160). */
export type ContentsChoiceDetails = { counts: { places: number; things: number } };

/** POST /api/v1/places/:id/restore and /things/:id/restore. `hint` when a child went to Unplaced. */
export type RestoreResult = { restored: string[]; hint?: string };

/** POST /api/v1/places/:id/convert-to-container → the same id as a thing (Q14). */
export type ConvertToContainerBody = { typeId?: string };
export type ConvertToContainerResult = { thingId: string };

/** POST /api/v1/places/:id/label (`labels` module; printing is step 3). */
export type LabelResult = { code: string };

// ----- things (task 14) ------------------------------------------------------------------------

export type TypeRef = { id: string; icon: IconRef; name: string | null; builtinKey: string | null };

/** The list row every thing list, search result and link shows (`things/view.ts`). */
export type ThingRow = {
  id: string;
  locationId: string;
  /** The primary short ID (D120), 6 Crockford characters, or null until allocated. */
  shortCode: string | null;
  /** Null only while `derivedState` has `draft`. */
  name: string | null;
  type: TypeRef | null;
  quantity: number;
  lifecycle: Lifecycle;
  derivedState: DerivedState[];
  path: PathStep[];
  /** The container's first photo, beside the path (D195). */
  containerThumbUrl: string | null;
  thumbUrl: string | null;
  lastSeenAt: string | null;
  /** Search only: the alias the query matched ("matched: display cable", screens §8). */
  matchedAlias?: string;
  /**
   * Search only: found by meaning alone, not by its words (step 6 T14, D200): "matched by meaning".
   */
  matchedBy?: 'meaning';
  /**
   * A container type, or anything with live things inside (T25 decision 3; the server's
   * `isContainerSql()`). Lists, details and search rows all send it.
   */
  isContainer: boolean;
};

export type ThingMeter = {
  id: string;
  kind: string;
  unit: string;
  label: string | null;
  latest: { value: string; takenAt: string } | null;
  needsReview: number;
  /** For PATCH /api/v1/meters/:id (If-Match, T16). */
  rowVersion: number;
};

export type ThingPurchase = {
  purchaseId: string | null;
  purchasedOn: string | null;
  vendor: { id: string; name: string } | null;
  /** Left out with the price when money is hidden. */
  currency?: string | null;
  lineDescription: string | null;
  quantity: number | null;
  unitPrice?: string;
  /** The price (and its receipts) were withheld from this caller. */
  moneyHidden?: true;
  receipts: AttachmentView[];
};

/** GET /api/v1/things/:id. */
export type ThingView = ThingRow & {
  brand: { id: string; name: string } | null;
  model: string | null;
  serial: string | null;
  barcode: string | null;
  colour: string | null;
  condition: Condition | null;
  notes: string | null;
  /** Per language (D41): `{en: [...], ar: [...]}`. */
  aliases: Record<string, string[]>;
  tags: { id: string; name: string; colour: string | null }[];
  belongsTo: { id: string; displayName: string } | null;
  manualUrl: string | null;
  expiresOn: string | null;
  expiryLeadDays: number | null;
  ended: {
    on: string | null;
    price?: string;
    currency?: string;
    moneyHidden?: true;
    to: string | null;
    notes: string | null;
  } | null;
  acquiredFrom: string | null;
  provenanceNotes: string | null;
  locationUncertain: boolean;
  reviewState: 'draft' | 'confirmed';
  fieldStatus: Record<string, { state: 'extracted' | 'confirmed' | 'manual'; confidence?: number }>;
  fields: ResolvedField[];
  /** Gated: money-kind values are dropped without `showMoney`; secrets never appear here. */
  custom: Record<string, unknown>;
  /** Values of fields the type no longer has (D92: re-type archives, never deletes). */
  archivedCustom: Record<string, unknown>;
  secrets: SecretSummary[];
  placeId: string | null;
  containerId: string | null;
  /** Has the `container` capability, or has contents. */
  isContainer: boolean;
  contentsCount: number;
  purchase: ThingPurchase | null;
  photos: AttachmentView[];
  attachmentsCount: number;
  meters: ThingMeter[];
  links: { id: string; kind: LinkKind; direction: 'from' | 'to'; thing: ThingRow }[];
  /** Money is withheld from this caller here (custom money values are left out too). */
  moneyHidden?: true;
  /**
   * Step 4, T8 (D158): the latest valuation (`valued_on`, then the latest made), behind the money
   * gate; null when there is none; absent with the Money module off.
   */
  currentValue?: ThingCurrentValue | null;
  /**
   * Step 4, T9 (D54): the claim in repair. The path line reads "at <vendor>" and the header
   * "Usually in <place>" (screens §8). `vendorName` is null for a claim without a vendor.
   */
  repairAt?: { vendorName: string | null } | null;
  /**
   * Step 4, T10 (D57): the open loan, which the web formats as "with Murdock since 3 Oct · due
   * 17 Oct". Shape proposed by T20 (the plan names `loanLine` only); a person's name is not a
   * contact detail (plan Q34), so nothing else about them is here.
   */
  loanLine?: ThingLoanLine | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

/** The thing view's current value (T8): the amount, or only that it's hidden (the money gate). */
export type ThingCurrentValue =
  | { amount: string; currency: string; valuedOn: string; source: ValuationSource }
  | { moneyHidden: true };

/** The thing view's open loan (T10; proposed by T20). */
export type ThingLoanLine = {
  direction: LoanDirection;
  personName: string;
  /** When it went out (or came in): an ISO time. */
  startedAt: string;
  dueOn: string | null;
  overdue: boolean;
};

/** GET /api/v1/things query (list-standard, global by default, D174). */
export type ThingListParams = {
  locationId?: Many;
  placeId?: string;
  containerId?: string;
  typeId?: Many;
  tagId?: Many;
  /** Things that belong to this person (the person page, D57; task 28 asks task 14). */
  belongsToId?: Many;
  /** Things of this brand (the brand page). */
  brandId?: Many;
  /** Things bought from this vendor, through their purchase line (the vendor page). */
  vendorId?: string;
  state?: Many<DerivedState>;
  /** Which of the filters above are "is none of" (D205). */
  not?: ('locationId' | 'typeId' | 'tagId' | 'belongsToId' | 'brandId' | 'state')[];
  lifecycle?: Lifecycle;
  /** `1` ⇒ containers only (T26). */
  container?: 1;
  /** The things an import run brought in ("Imported by", step-7 T16). Owners and admins; for
   * anyone else the server matches nothing. */
  importRunId?: string;
  q?: string;
  group?: 'type' | 'place' | 'none';
  sort?: 'name' | 'updated' | 'lastSeen';
  /** The sort turned around (D211). Absent: A to Z for the name, newest first for dates. */
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
};

/** POST /api/v1/things → 201 ThingView. Exactly one of `placeId` / `containerId`. */
export type CreateThingBody = {
  id?: string;
  locationId: string;
  placeId?: string;
  containerId?: string;
  name: string;
  typeId?: string;
  quantity?: number;
  brandId?: string;
  model?: string;
  serial?: string;
  barcode?: string;
  colour?: string;
  condition?: Condition;
  notes?: string;
  aliases?: Record<string, string[]>;
  tagIds?: string[];
  belongsToPersonId?: string;
  manualUrl?: string;
  expiresOn?: string;
  expiryLeadDays?: number;
  custom?: Record<string, unknown>;
  /** Makes a one-line purchase. */
  purchase?: { purchasedOn: string; vendorId?: string; currency: string; price: string };
  /** Quick add (T19): the template's payload is the base, and the fields sent here win. */
  templateId?: string;
};

/**
 * PATCH /api/v1/things/:id (If-Match). `custom` merges per key (`null` removes); `aliases`
 * replaces per language; `tagIds` replaces the set.
 */
export type UpdateThingBody = {
  name?: string;
  typeId?: string | null;
  quantity?: number;
  brandId?: string | null;
  model?: string | null;
  serial?: string | null;
  barcode?: string | null;
  colour?: string | null;
  condition?: Condition | null;
  notes?: string | null;
  aliases?: Record<string, string[]>;
  tagIds?: string[];
  belongsToPersonId?: string | null;
  manualUrl?: string | null;
  expiresOn?: string | null;
  expiryLeadDays?: number | null;
  acquiredFrom?: string | null;
  provenanceNotes?: string | null;
  custom?: Record<string, unknown | null>;
};

/**
 * The body of a 412 on any versioned write (D156): the fields that changed under you, the
 * current version, and who changed it. The client re-reads the row for the values.
 */
export type ConflictDetails = {
  conflicts: string[];
  row_version: number;
  changedBy?: ActorRef;
};

/** POST /api/v1/things/:id/lifecycle (If-Match). `in_use` clears the end fields ("found", D119). */
export type LifecycleBody = {
  lifecycle: Lifecycle;
  endedOn?: string;
  endedPrice?: string;
  endedCurrency?: string;
  endedTo?: string;
  endedNotes?: string;
};

/** POST /api/v1/things/:id/seen (D40). */
export type SeenResult = { lastSeenAt: string };

/** POST /api/v1/things/:id/retype (If-Match): matching keys map, the rest archive (D92). */
export type RetypeBody = { typeId: string };

/** POST /api/v1/things/:id/duplicate → 201 ThingView & {ownCodes}: the copy's own codes once it
 * committed, as for a create (D208; step 4, T19). */
export type DuplicateBody = { id?: string };

/** POST /api/v1/things/:id/split (D10). */
export type SplitBody = { quantity: number; id?: string; to?: MoveTarget };
export type SplitResult = { originalId: string; newId: string };

/** POST /api/v1/things/:id/links → 201; DELETE /api/v1/thing-links/:linkId. */
export type CreateLinkBody = { toThingId: string; kind: LinkKind };
export type ThingLink = ThingView['links'][number];

/**
 * POST /api/v1/things/:id/convert-to-place (If-Match; owners and admins). A thing carrying what a
 * place can't hold is refused, 409 `conflict` with `reason: 'discards'` and the list, unless
 * `discard: true`; meters always refuse (they must go first).
 */
export type ConvertToPlaceBody = { parentId?: string; discard?: boolean };
export type ConversionLoss =
  | 'brand'
  | 'ended'
  | 'links'
  | 'meters'
  | 'purchase'
  | 'serial'
  | 'tags';
export type ConvertToPlaceConflict = { reason?: 'discards'; discards?: ConversionLoss[] };
export type ConvertToPlaceResult = { placeId: string };

/** GET /api/v1/codes/:code: a 404 is identical for missing and forbidden codes (D137). */
export type CodeLookup = { kind: 'thing' | 'place'; id: string };

// ----- moves (task 15) -------------------------------------------------------------------------

/** POST /api/v1/things/move/preview (read-only; D45's "who will lose sight"). */
export type MovePreviewBody = { thingIds: string[]; to: MoveTarget };
export type MovePreview = {
  crossLocation: boolean;
  crossAccount: boolean;
  targetLocation: { id: string; name: string };
  losesSight: ActorRef[];
  copies: {
    types: number;
    tags: number;
    people: number;
    vendors: number;
    brands: number;
    purchases: number;
  };
};

/** POST /api/v1/things/move: ≤ 200 things; `quantity` only with one thing (it splits first). */
export type MoveBody = { thingIds: string[]; to: MoveTarget; quantity?: number };
export type MoveResult = { moved: string[] };

/** POST /api/v1/things/:id/empty-into ("Empty Box 3 into Box 5", D45). */
export type EmptyIntoBody = { to: MoveTarget };

// ----- meters and readings (task 16) -----------------------------------------------------------

export type CreateMeterBody = { kind: string; unit: string; label?: string; maxPerDay?: number };
export type UpdateMeterBody = { label?: string | null; maxPerDay?: number | null };

export type ReadingSource = 'manual' | 'photo' | 'fuel' | 'service' | 'import' | 'home_assistant';
export type ReadingState = 'accepted' | 'needs_review';
/** `ai_read`: a reading AI read that fits, waiting for a person all the same (D19; the server's
 * meters/routes.ts). */
export type ReviewReason =
  | 'lower_than_previous'
  | 'higher_than_next'
  | 'implausible_jump'
  | 'ai_read';

export type Reading = {
  id: string;
  value: string;
  takenAt: string;
  source: ReadingSource;
  state: ReadingState;
  reviewReason: ReviewReason | null;
  loggedBy: ActorRef;
  note: string | null;
  /** For PATCH /api/v1/readings/:id's optional If-Match (T16). */
  rowVersion: number;
};

/** POST /api/v1/meters/:id/readings. `takenAt` is clamped to now (D112). */
export type CreateReadingBody = { id?: string; value: string; takenAt: string; note?: string };
export type CreateReadingResult = { reading: Reading; state: ReadingState; reason?: ReviewReason };
export type UpdateReadingBody = { value?: string; takenAt?: string; note?: string | null };
/**
 * A backwards reading is refused online (D26): 409 `conflict` with the neighbour it collides
 * with; the hint says what to check.
 */
export type ReadingConflictDetails = {
  reason?: 'lower_than_previous' | 'higher_than_next';
  previous?: { value: string; takenAt: string };
  next?: { value: string; takenAt: string };
};
/** POST /api/v1/meters/:id/replaced (D52). */
export type MeterReplacedBody = { at: string; offset: string };

// ----- files and attachments (task 17) ---------------------------------------------------------

export type DerivativeState = 'ready' | 'pending' | 'unavailable' | 'not_applicable';

/** PUT /api/v1/files/:fileId?locationId=&class= (raw body; `X-Kept-Sha256`) → 201 or 200. */
export type FileView = {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
  class: FileClass;
  hasGps: boolean;
  width: number | null;
  height: number | null;
  derivativeState: DerivativeState;
  thumbUrl: string | null;
  displayUrl: string | null;
  /** Present on a per-location dedupe hit (D177). */
  deduplicatedFrom?: string;
};

export type FileVariant = 'original' | 'display' | 'thumb' | 'share';
/** POST /api/v1/files/:id/url (`?thingId=` for a receipt after a move). */
export type FileUrlBody = { variant: FileVariant };
export type FileUrl = { url: string; expiresAt: string };
/** DELETE /api/v1/files/:id: "delete original" (D162), admin only, audited with the reason. */
export type DeleteFileBody = { reason: string };

/**
 * What an attachment hangs on. Step 4 adds a warranty's and a claim's documents (T9), a loan's
 * condition photos (T10), a service record's invoice (T11), an expiring document's files (T12)
 * a valuation's documents (T8) and an incident's (T18), the `warranty_id`, `claim_id`, `loan_id`,
 * `service_record_id`, `expiring_document_id`, `valuation_id` and `incident_id` columns of §7.13.
 */
export type AttachmentSubject =
  | { thingId: string }
  | { placeId: string }
  | { purchaseId: string }
  | { meterReadingId: string }
  | { location: true }
  | { warrantyId: string }
  | { claimId: string }
  | { loanId: string }
  | { expiringDocumentId: string }
  | { valuationId: string }
  | { serviceRecordId: string }
  | { incidentId: string }
  /** Step 5 (T11): a fill's pump receipt. */
  | { fuelEntryId: string };

export type AttachmentView = {
  id: string;
  role: AttachmentRole;
  sort: number;
  file: FileView | null;
  /** A URL attachment (never fetched by the server, D128). */
  url: string | null;
  subject: AttachmentSubject;
  createdBy: ActorRef;
  /** For PATCH /api/v1/attachments/:id (If-Match, T17). */
  rowVersion: number;
};

/** POST /api/v1/attachments → 201 AttachmentView. Exactly one of `fileId` / `url`. */
export type CreateAttachmentBody = {
  id?: string;
  locationId: string;
  fileId?: string;
  url?: string;
  subject: AttachmentSubject;
  role: AttachmentRole;
  sort?: number;
};
/** PATCH /api/v1/attachments/:id (If-Match). */
export type UpdateAttachmentBody = { role?: AttachmentRole; sort?: number };

// ----- secrets (task 19) -----------------------------------------------------------------------

/** PUT /api/v1/{things|places}/:id/secrets/:fieldKey → 204. 409 `recovery_kit_required` (D193). */
export type SetSecretBody = { value: string };
/** POST …/secrets/:fieldKey/reveal (D175): shown for 30 s; `Cache-Control: no-store`. */
export type RevealResult = { value: string; revealedUntil: string };
/** GET|PUT /api/v1/locations/:id/secret-policies/:typeFieldId (owner only, D177). */
export type SecretPolicy = {
  revealRoles: ('owner' | 'admin' | 'member' | 'viewer')[];
  revealUserIds: string[];
  aiAllowed: boolean;
};

// ----- search and saved views (task 20) --------------------------------------------------------

export type SearchKind = 'things' | 'places' | 'people' | 'vendors' | 'documents';

/**
 * Search's `state` filter: a derived state, or one of Home's attention rows (task 29 asks task
 * 20), so each attention count opens its list: readings to review, not seen for
 * `long_unseen_months`, and things in an Unplaced area.
 */
export type SearchStateFilter = DerivedState | 'to_review' | 'long_unseen' | 'unplaced';

/** GET /api/v1/search query. */
export type SearchParams = {
  q?: string;
  locationId?: Many;
  /** The whole place subtree, plus containers within it. */
  placeId?: Many;
  typeId?: Many;
  tagId?: Many;
  state?: Many<SearchStateFilter>;
  /** Which of the filters above are "is none of" (D205). */
  not?: ('locationId' | 'placeId' | 'typeId' | 'tagId' | 'state')[];
  /** With a kind, only that group is paginated. */
  kind?: SearchKind;
  /**
   * Unit price bounds (decimal strings) and the currency they're in (T27 decision). The server
   * ignores them for a caller who can't see money.
   */
  priceMin?: string;
  priceMax?: string;
  currency?: string;
  limit?: number;
  cursor?: string;
};

export type PlaceResult = {
  id: string;
  locationId: string;
  name: string;
  kindKey: string;
  icon: IconRef | null;
  path: PathStep[];
};
export type PersonResult = { id: string; displayName: string; ownerAccountId: string };
export type VendorResult = { id: string; name: string; kind: VendorKind; ownerAccountId: string };

/** What a matching document is attached to (apps/server/src/search/documents.ts). */
export type DocumentSubjectKind =
  | 'thing'
  | 'place'
  | 'purchase'
  | 'meter_reading'
  | 'incident'
  | 'location';
/**
 * One attachment whose file's text matches (T21, f595aab): a PDF's text layer, or a receipt's.
 * `subject.name` is the thing's, place's or location's name; a purchase's vendor; a reading's
 * thing. `snippet` is an excerpt around the first match, as the document wrote it (plain text,
 * no ellipses), sent only where the caller sees money; elsewhere there is no `snippet` and
 * `moneyHidden` is set. Receipts and invoices where money is hidden are never results.
 */
export type DocumentResult = {
  attachmentId: string;
  fileId: string;
  locationId: string;
  subject: { kind: DocumentSubjectKind; id: string; name: string | null };
  role: AttachmentRole;
  snippet?: string;
  moneyHidden?: true;
};

/**
 * Without `kind`, each group has its first 5 (things 20). `didYouMean` is filled only when
 * nothing matched. `asOf` is the server time of the answer.
 */
export type SearchResponse = {
  things: Page<ThingRow>;
  places: PlaceResult[];
  people: PersonResult[];
  vendors: VendorResult[];
  /** Attachments whose text matches (T21); `kind=documents` asks for this group alone. */
  documents: { items: DocumentResult[] };
  didYouMean: string[];
  asOf: string;
  /**
   * Semantic search's state for this query (step 6 T14, D200, §7.15): absent or null when meaning
   * was searched too; otherwise why the results are keyword only: `paused` (a cap, until when),
   * `waiting` (the provider's limit), `off` (the server's embeddings are off) or `keyword_only`
   * (no embeddings model for the searched locations).
   */
  semantic?: SemanticState | null;
};

export type SemanticState = {
  state: 'paused' | 'waiting' | 'off' | 'keyword_only';
  until?: string;
};

/**
 * A saved view (D42, D183, D205): a list's filters kept under a name, for you or shared with one
 * location (sharing needs `saved-views.share`). `query` is the list's URL state (SavedListQuery),
 * validated against the filters its `surface` offers.
 */
export type SavedView = {
  id: string;
  name: string;
  surface: ListSurface;
  query: SavedListQuery;
  /** Null ⇒ personal; a location id ⇒ shared with that location. */
  sharedLocationId: string | null;
  createdBy: ActorRef;
  /** You made it (only its maker may change it). */
  mine: boolean;
  rowVersion: number;
  /** Its price bounds were withheld from this caller (money hidden here). */
  moneyHidden?: true;
};
/** Your default view and pinned views (tabs) on one list (D205). */
export type SavedViewPrefs = { defaultViewId: string | null; pinned: string[] };
/**
 * GET /api/v1/saved-views?surface&limit&cursor: yours and your locations' shared ones, by name, a
 * page at a time (at most 100 a page); `prefs` when a surface is asked for. At most 100 of your
 * own: a create past that is 409 `conflict` with `reason: 'limit'`.
 */
export type SavedViewsResponse = {
  views: SavedView[];
  next_cursor: string | null;
  prefs: SavedViewPrefs | null;
};
export type CreateSavedViewBody = {
  id?: string;
  name: string;
  surface: ListSurface;
  query: SavedListQuery;
  sharedLocationId?: string | null;
};
export type UpdateSavedViewBody = {
  name?: string;
  query?: SavedListQuery;
  sharedLocationId?: string | null;
};

// ----- trash, history and activity (task 21) ---------------------------------------------------

/** GET /api/v1/trash?locationId&kind&q&cursor. */
export type TrashItem = {
  kind: 'thing' | 'place';
  id: string;
  locationId: string;
  name: string | null;
  path: PathStep[];
  deletedAt: string;
  /** Who trashed it; the id is the "Deleted by" filter's value (D205). */
  deletedBy: (ActorRef & { id: string }) | null;
  /** 30 days after `deletedAt`. */
  purgeAfter: string;
  /** How many rows were trashed together (the same `trash_batch_id`). */
  batchSize: number;
};

/**
 * One field of a rendered diff: `RenderedChange` of apps/server/src/audit/render.ts, verbatim.
 * Money the viewer may not see is `hidden` with no values; a secret is `changed`, never a value
 * (D110).
 */
export type RenderedChange = (
  | { before: unknown; after: unknown; class: 'plain' | 'money' }
  | { changed: true; class: 'money'; hidden: true }
  | { changed: true; class: 'secret' }
) & {
  /**
   * For `custom.<key>` (T27 decision): the type field's label, or `labelKey` for a built-in
   * field (the web translates it from the shared library).
   */
  label?: string;
  labelKey?: string;
};

/**
 * A history or activity row: the server's `RenderedAuditEvent` (snake_case, as `renderAudit`
 * returns it) plus the actor's display name and a one-line summary (plan task 21).
 */
export type HistoryEvent = {
  id: string;
  at: string;
  location_id: string | null;
  action: string;
  actor: { type: string; id: string | null; displayName: string | null };
  /**
   * `shortCode`: a thing's or place's primary short ID, for its `/t/`/`/p/` address (D208). The
   * server always sends it (null for other entities, or none yet); rows the mock keeps may not.
   */
  entity: { type: string; id: string | null; shortCode?: string | null };
  root_thing_id: string | null;
  diff: Record<string, RenderedChange> | null;
  undo_of: string | null;
  undoable_until: string | null;
  /** English fallback of the summary line. */
  summary: string;
  /**
   * The summary's structured form (T27 decision, apps/server/src/history/summary.ts): `<entity>.
   * <verb>`, `thing.move.in`/`.out`, `<entity>.restore`, `undo`, or `event` with `{action}`.
   * The web localises it; `summary` is the fallback.
   */
  summaryKey: string;
  summaryParams: Record<string, string>;
  /** A `thing.move` arriving from a location the viewer can't see (D183): rendered with no diff. */
  movedInFromElsewhere?: boolean;
  /**
   * An `ai_call` entry (D206, engineering spec §7.15 "Elsewhere"): a ledger row with this thing's
   * id or an extraction of its attachments, visible to whoever sees the thing, cost per the gate.
   * Such an entry has `action: 'ai.call'`, `summaryKey: 'ai.call'`, no diff and no undo.
   */
  aiCall?: AiCallSummary & { task: LedgerTask };
  /**
   * A thing's history: an event of a thing merged into this one (D36, plan Q16, T15), shown as
   * "merged from <name>". `name` is the merged thing's, null when it had none.
   */
  mergedFrom?: { id: string; name: string | null };
};

/** GET /api/v1/activity?locationId&actorId&entityType&from&to&cursor (global, D174). */
export type ActivityParams = {
  /** Words in the summary, the entity's name or the actor (T27 decision). */
  q?: string;
  locationId?: Many;
  actorId?: Many;
  entityType?: Many;
  /** Which of the filters above are "is none of" (D205). */
  not?: ('locationId' | 'actorId' | 'entityType')[];
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

/** GET /api/v1/locations/:id/actors: who has acted there, for the Activity person filter. */
export type ActorsResponse = { items: { id: string; displayName: string }[] };

/**
 * POST /api/v1/audit/:eventId/undo (D150, T27 decision; T20): reverses one event inside its
 * `undoable_until` window. Step 2: thing.update/retype/lifecycle/move/trash, place.update/move;
 * step 3 adds place.trash, thing.capture, capture.batch_undo, thing.extract, purchase.extract,
 * box.check and inbox.bulk. A refusal is 409 `undo_refused` with a hint and a `reason`
 * (api/capture/types.ts UndoRefusedDetails): `changed_since` (with `field`, `conflicts` and
 * `changedBy`), `already_undone`, `expired` or `not_undoable`.
 */
export type UndoResult = { undoOf: string; eventId: string };

// ----- home and hints (task 22) ----------------------------------------------------------------

export type ChecklistKey =
  | 'locationCreated'
  | 'threeThings'
  | 'labelPrinted'
  | 'invited'
  | 'aiConnected'
  | 'installed';

/**
 * GET /api/v1/home. "Put Kept on HTTPS" is added by the client over http (D193). Zero attention
 * rows are hidden by the client, in the §8 order.
 *
 * Step 3 (T22): `attention.toReview` counts the open inbox items of your writable locations
 * (yours and everyone's) plus the things with a reading to review that isn't already an inbox
 * item; `counts.inbox` is those items alone (the row opens the inbox when there are any, and
 * the sidebar's Inbox badge shows it); `counts.unprintedLabels` is the things whose code was
 * never printed, where Labels is on (Q28).
 */
export type HomeResponse = {
  checklist: { dismissed: boolean; items: { key: ChecklistKey; done: boolean }[] };
  attention: {
    toReview: number;
    uncertain: number;
    longUnseen: number;
    unplaced: number;
    /**
     * Step 4 (T13): GET /agenda's counts, and the open loans out and in (GET /loans?state=open's
     * `counts.out`, `counts.in`). Optional while the mock's /home doesn't send them.
     */
    overdue?: number;
    due?: number;
    expiring?: number;
    lentOut?: number;
    borrowedIn?: number;
    /** Step 7 (T17, T23): things below their "keep at least", where Consumables is on. */
    lowStock?: number;
  };
  /** Step 4 (T13): each of overdue, due and expiring by source, so a row opens Schedules when
   * every item is a schedule and Expiring otherwise. Optional as `attention`'s step-4 counts. */
  agendaBySource?: Record<
    'overdue' | 'due' | 'expiring',
    Partial<Record<ActiveSourceType, number>>
  >;
  counts: { inbox: number; unprintedLabels: number };
  locations: { id: string; thingCount: number; unplacedCount: number }[];
};

export type Hint = { key: string; seenAt: string | null; dismissedAt: string | null };
/** GET /api/v1/me/hints. */
export type HintsResponse = { hints: Hint[] };
/** PUT /api/v1/me/hints/:key. */
export type UpdateHintBody = { seen?: boolean; dismissed?: boolean };

// ----- the inventory report (task 32, D201; apps/server/src/reports/service.ts) ----------------

/** What a report covers: one location, or an account across the locations you can see. */
export type ReportScope = { locationId: string } | { accountId: string };

/** POST /api/v1/reports/inventory. Money follows the server's gates; `locale` and `digits`
 * default to the requester's own settings (English unless they read Arabic). */
export type InventoryReportBody = {
  scope: ReportScope;
  filters?: {
    placeIds?: string[];
    typeIds?: string[];
    tagIds?: string[];
    /** Exactly these things, at most PRINT_MAX_THINGS: "Print" on a list (step-7 T16). */
    thingIds?: string[];
    includeEnded?: boolean;
    includeTrashed?: boolean;
  };
  include?: { photos?: boolean; qr?: boolean; money?: boolean };
  locale?: 'en' | 'ar';
  digits?: 'western' | 'eastern';
};

/** 202 from POST /api/v1/reports/inventory. */
export type ReportCreated = { id: string; status: 'queued'; expiresAt: string };

export type ReportStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

/** Why a run failed (the server's `error`); anything else is shown as a general failure. */
export type ReportError =
  | 'too_many_things'
  | 'timeout'
  | 'memory'
  | 'render'
  | 'no_storage'
  | 'internal';

/** GET /api/v1/reports/:id. Someone else's run, or one past its purge, is a 404. */
export type ReportRun = {
  id: string;
  status: ReportStatus;
  scope: ReportScope;
  progress: { done: number; total: number };
  /** A five-minute signed URL (attachment), only while `done`. */
  fileUrl?: string;
  /** The same PDF signed `inline`, for Open PDF: an installed iPhone app can't download. */
  viewUrl?: string;
  bytes?: number;
  error?: string;
  createdAt: string;
  expiresAt: string;
};
