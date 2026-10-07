/**
 * The step-3 half of the mock server's state (capture, inbox, AI, labels, scan, imports,
 * templates, undo, sync), and its fixtures. Built fresh per scenario, next to step 2's inventory
 * (api/inventory/mock), whose things and places it points at by id: inbox items and batches are
 * serialised from the live inventory, so a trashed or renamed thing shows up as it is now.
 *
 * What the fixtures hold (plan T3): an Arabic household (بيت العائلة) with its own capture batch
 * and receipt; two capture batches; one inbox item of each kind; blank labels; and AI "paused
 * until" the 1st of next month in Home. Test and demo data only.
 *
 * T27 adds a third batch, Saturday's capture on Garage › Shelves: an AI-named impact driver with
 * a serial and a manufacture date waiting as Suggested (T10's kinds of suggestion, which T15's
 * accept can write), two named drafts ready to accept, one still
 * "Naming…", one the provider failed on, one waiting for the provider, and the Ace Hardware
 * receipt whose lines link to them (the J2 order: photo first, receipt later). Its drafts are
 * `seedThings`, added to the inventory on the first inbox request (./inbox.ts), so step 2's
 * fixtures and their tests keep their counts.
 */
import { INBOX_KINDS, type InboxKind, RECOMMENDED, type SyncOpResult } from '@kept/shared';
import type { StoredThing } from '../../inventory/mock/db';
import { INV_IDS } from '../../inventory/mock/fixtures';
import type { ActorRef, PathStep } from '../../inventory/types';
import type {
  AccountTemplate,
  AiCall,
  AiCap,
  AiPrice,
  AiProvider,
  AiStatus,
  ExtractionAttempt,
  ImportRun,
  InboxItem,
  LabelBatch,
  UndoableEvent,
} from '../types';

/** An inbox item as the mock stores it; `thing` and `duplicate.other` are read live. */
export type StoredInboxItem = Omit<InboxItem, 'thing' | 'duplicate' | 'createdBy' | 'batch'> & {
  /** The capturing user's id: "Mine" compares it with the signed-in user. */
  createdById: string;
  /** Null: the signed-in user (their display name is read at request time). */
  createdByName: string | null;
  batchId: string | null;
  thingId?: string;
  photos?: { fileId: string; thumbUrl: string | null }[];
  fieldStatus?: Record<
    string,
    { state: 'manual' | 'extracted' | 'confirmed'; confidence?: number }
  >;
  duplicate?: { otherThingId: string; reason: 'serial' | 'brand_model_place' };
  resolvedAt: string | null;
  resolution: string | null;
};

export type StoredBatch = {
  batchId: string;
  locationId: string;
  placeId: string;
  capturedAt: string;
  createdById: string;
  thingIds: string[];
};

/** A code from outside Kept (D146 Homebox labels; own codes later, D208) on a thing or place. */
export type StoredLegacyCode = {
  locationId: string;
  source: 'homebox' | 'csv' | 'own';
  code: string;
  target: { kind: 'thing' | 'place'; id: string };
};

/** `KEPT_PUBLIC_URL + '/l/' + code` (D120): the mock's public URL is the page's own origin. */
export function urlOf(code: string): string {
  const origin = typeof location === 'undefined' ? 'http://kept.test' : location.origin;
  return `${origin}/l/${code}`;
}

export type StoredCode = {
  code: string;
  locationId: string;
  state: 'blank' | 'assigned';
  target: { kind: 'thing' | 'place'; id: string; name: string } | null;
  printedAt: string | null;
};

/**
 * A draft the capture fixtures own: completed from the inventory's own draft (its template) and
 * added to the inventory on the first inbox request. `typeId` is resolved against its types then.
 */
export type SeedThing = Partial<StoredThing> & { id: string; locationId: string; typeId?: string };

export type CaptureState = {
  batches: StoredBatch[];
  /** Drafts not yet in the inventory (see SeedThing); emptied once added. */
  seedThings: SeedThing[];
  inbox: StoredInboxItem[];
  /** Per location; a location without an entry answers "no provider". */
  aiStatus: Record<string, AiStatus>;
  providers: AiProvider[];
  caps: AiCap[];
  prices: AiPrice[];
  calls: AiCall[];
  /** Per thing, newest attempt last. */
  extractions: Record<string, ExtractionAttempt[]>;
  labelBatches: LabelBatch[];
  codes: StoredCode[];
  /** Old labels that resolve by scan (T17's `legacy_codes`). */
  legacyCodes: StoredLegacyCode[];
  imports: ImportRun[];
  /** Account templates, with the account that owns them. */
  templates: (AccountTemplate & { accountId: string })[];
  /** Per thing: its undoable events (T20). */
  undoable: Record<string, UndoableEvent[]>;
  /** `sync_ops` by idempotency key: a replay answers the stored result (T14). */
  syncOps: Record<string, SyncOpResult>;
  /** `instance_settings.barcode_lookup` (D126): off by default. */
  barcodeLookup: boolean;
  /** Barcodes the lookup knows (Open Food Facts stand-ins). */
  products: Record<string, { name: string; brand: string | null; quantity: string | null }>;
  /** Snapshot pages served so far (T12's cursor stand-in). */
  snapshotPass: number;
};

// ----- ids and time ----------------------------------------------------------------------------

const cid = (n: number) => `01926f00-0000-7000-8000-0000001${String(n).padStart(5, '0')}`;

/** Ids tests and demo links can use. */
export const CAPTURE_IDS = {
  batch: { homeOffice: cid(1), familyKitchen: cid(2), garageShelves: cid(3) },
  inbox: {
    draft: cid(11),
    reading: cid(12),
    labelClaim: cid(13),
    currency: cid(14),
    duplicate: cid(15),
    receipt: cid(16),
    syncDrop: cid(17),
    arDraft: cid(18),
    // Saturday's capture on Garage › Shelves (T27).
    driver: cid(131),
    cord: cid(132),
    extinguisher: cid(133),
    naming: cid(134),
    failed: cid(135),
    waiting: cid(136),
    aceReceipt: cid(137),
    // A photo captured in Garage before its AI key was connected: a draft with no extraction.
    early: cid(138),
  },
  /** The drafts of Saturday's capture (seedThings). */
  seed: {
    driver: cid(141),
    cord: cid(142),
    extinguisher: cid(143),
    naming: cid(144),
    failed: cid(145),
    waiting: cid(146),
    early: cid(147),
  },
  extraction: { draft: cid(21), drill: cid(22) },
  purchase: { currency: cid(31), arReceipt: cid(32), ace: cid(33) },
  file: { draftPhoto: cid(41), receiptPage: cid(42), odometer: cid(43), arPhoto: cid(44) },
  provider: { account: cid(51) },
  cap: { home: cid(61) },
  price: { groq: cid(71) },
  call: {
    ok: cid(81),
    paused: cid(82),
    receipt: cid(83),
    label: cid(84),
    timeout: cid(85),
    retry: cid(86),
    test: cid(87),
    instance: cid(88),
    family: cid(89),
    driver: cid(171),
    cord: cid(172),
    extinguisher: cid(173),
  },
  labelBatch: { blank: cid(91) },
  importRun: { done: cid(101) },
  template: { storageBox: cid(111) },
  /** Someone else in Home (the sample cast). */
  alfred: cid(121),
  talia: cid(122),
} as const;

/** Blank labels printed for Home and not claimed yet (D43). */
export const BLANK_CODES = ['B7NK4X', 'C3QM8R', 'D9TW2P'] as const;
/** A label already claimed on another phone, for the `label_claim` item. */
export const CLAIMED_CODE = 'F4HX7N';
/**
 * Homebox asset IDs (D146): one on the drill in Garage, and one that two imported collections
 * both used, on Box 3 in Home and the HDMI cable in بيت العائلة (the collection picker, T26).
 */
export const HOMEBOX_ASSET = { unique: '000-014', ambiguous: '000-021' } as const;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
/** 00:00 UTC on the 1st of next month: when a monthly cap's pause ends (§7.15). */
export function firstOfNextMonth(from = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)).toISOString();
}

export const actor = (displayName: string): ActorRef => ({ displayName });

const emptyCounts = (): Record<InboxKind, number> =>
  Object.fromEntries(INBOX_KINDS.map((k) => [k, 0])) as Record<InboxKind, number>;

export { emptyCounts };

/** `PathStep`s for a batch that doesn't need the inventory (a place the fixtures don't hold). */
export const step = (id: string, name: string): PathStep => ({
  id,
  name,
  kind: 'place',
  isUnplaced: false,
});

// ----- fixtures --------------------------------------------------------------------------------

export function captureFixtures(meId: string): CaptureState {
  const L = INV_IDS.loc;
  const P = INV_IDS.place;
  const T = INV_IDS.thing;
  const I = CAPTURE_IDS;
  const pausedUntil = firstOfNextMonth();
  const S = I.seed;
  /** The signed-in person, as the ledger names them. */
  const me = { id: meId, name: 'Ibrahim' };
  const Y = INV_IDS.type;
  const saturday = ago(20);
  const seedAt = (extra: Omit<SeedThing, 'locationId' | 'placeId'>): SeedThing => ({
    locationId: L.garage,
    placeId: P.shelves,
    containerId: null,
    reviewState: 'draft',
    createdAt: saturday,
    updatedAt: saturday,
    lastSeenAt: saturday,
    ...extra,
  });
  const extracted = (fields: string[], confidence = 0.93) =>
    Object.fromEntries(fields.map((f) => [f, { state: 'extracted' as const, confidence }]));
  /** A succeeded extraction; `callId` is its ledger row (I.call.*), so the AI line opens it. */
  const done = (id: string, tokens: number, cost: string, callId: string) => ({
    id,
    status: 'succeeded' as const,
    call: {
      id: callId,
      model: RECOMMENDED.model,
      providerKind: RECOMMENDED.kind,
      tokens,
      images: 1,
      cost: { amount: cost, currency: 'USD' },
      costSource: 'price_table' as const,
      paidBy: { scope: 'account' as const, label: 'Garage', mine: true },
      outcome: 'ok' as const,
    },
  });
  const item = (
    id: string,
    kind: InboxKind,
    locationId: string,
    extra: Partial<StoredInboxItem> = {},
  ): StoredInboxItem => ({
    id,
    kind,
    locationId,
    createdAt: ago(2),
    createdById: meId,
    createdByName: null,
    rowVersion: 1,
    batchId: null,
    resolvedAt: null,
    resolution: null,
    ...extra,
  });

  return {
    batches: [
      {
        batchId: I.batch.homeOffice,
        locationId: L.home,
        placeId: P.office,
        capturedAt: ago(3),
        createdById: meId,
        thingIds: [T.draft],
      },
      {
        batchId: I.batch.familyKitchen,
        locationId: L.family,
        placeId: P.familyKitchen,
        capturedAt: ago(26),
        createdById: I.talia,
        thingIds: [T.arCharger],
      },
      {
        batchId: I.batch.garageShelves,
        locationId: L.garage,
        placeId: P.shelves,
        capturedAt: saturday,
        createdById: meId,
        thingIds: [S.driver, S.cord, S.extinguisher, S.naming, S.failed, S.waiting],
      },
    ],
    seedThings: [
      seedAt({
        id: S.driver,
        name: 'Bosch impact driver, 18 V',
        shortCode: '5JV3TD',
        typeId: Y.powerTool,
        brand: { id: INV_IDS.brand.bosch, name: 'Bosch' },
        model: 'GDR 18V-200',
        fieldStatus: extracted(['name', 'brand', 'model', 'type']),
      }),
      seedAt({
        id: S.cord,
        name: 'Extension cord, 5 m',
        shortCode: '7RC2NF',
        typeId: Y.cable,
        fieldStatus: extracted(['name', 'type']),
      }),
      seedAt({
        id: S.extinguisher,
        name: 'Fire extinguisher, 2 kg',
        shortCode: '8VN2TC',
        typeId: Y.fireExtinguisher,
        fieldStatus: extracted(['name', 'type'], 0.88),
      }),
      seedAt({ id: S.naming, name: null, shortCode: '3NZ6GE' }),
      seedAt({ id: S.failed, name: null, shortCode: '1QH5VA' }),
      seedAt({ id: S.waiting, name: null, shortCode: '6PD3KW' }),
      seedAt({ id: S.early, name: null, shortCode: '9KW4RP' }),
    ],
    inbox: [
      item(I.inbox.draft, 'draft', L.home, {
        batchId: I.batch.homeOffice,
        thingId: T.draft,
        photos: [{ fileId: I.file.draftPhoto, thumbUrl: null }],
        fieldStatus: {},
        extraction: {
          id: I.extraction.draft,
          status: 'paused_budget',
          statusReason: 'cap_money',
          pausedUntil,
          call: null,
        },
      }),
      item(I.inbox.arDraft, 'draft', L.family, {
        createdAt: ago(26),
        createdById: I.talia,
        createdByName: 'تاليا',
        batchId: I.batch.familyKitchen,
        thingId: T.arCharger,
        photos: [{ fileId: I.file.arPhoto, thumbUrl: null }],
        fieldStatus: { name: { state: 'extracted', confidence: 0.82 } },
        suggestions: [
          {
            field: 'serial',
            value: 'SN-4471-A',
            confidence: 0.71,
            source: { extractionId: cid(22), attachmentId: cid(23) },
          },
        ],
      }),
      item(I.inbox.reading, 'reading', L.home, {
        thingId: T.car,
        reading: {
          meter: { id: INV_IDS.meter.carOdometer, label: null, unit: 'km' },
          value: '52340',
          takenAt: ago(5),
          reason: 'lower_than_previous',
          neighbours: { before: { value: '53100', takenAt: ago(24 * 14) } },
          proofThumbUrl: null,
        },
      }),
      item(I.inbox.labelClaim, 'label_claim', L.home, {
        claim: {
          code: CLAIMED_CODE,
          claimedFor: { kind: 'thing', id: T.box3, name: 'Box 3' },
        },
      }),
      item(I.inbox.currency, 'currency', L.home, {
        currency: { seen: '$', options: ['USD', 'CAD'] },
        receipt: {
          purchaseId: I.purchase.currency,
          pages: [{ fileId: I.file.receiptPage, thumbUrl: null }],
          vendorSeen: 'Hardware Depot',
          total: '42.50',
          lines: [{ index: 0, description: 'Drill bits', quantity: '1', unitPrice: '42.50' }],
          flagged: false,
        },
      }),
      item(I.inbox.duplicate, 'duplicate', L.home, {
        thingId: T.cableBox,
        createdById: I.alfred,
        createdByName: 'Alfred',
        duplicate: { otherThingId: T.hdmiCable, reason: 'brand_model_place' },
      }),
      item(I.inbox.receipt, 'receipt', L.family, {
        createdById: I.talia,
        createdByName: 'تاليا',
        receipt: {
          purchaseId: I.purchase.arReceipt,
          pages: [{ fileId: cid(45), thumbUrl: null }],
          vendorSeen: 'بي تك',
          purchasedOn: '2026-09-20',
          currency: 'EGP',
          total: '1850.00',
          tax: '227.19',
          lines: [
            { index: 0, description: 'شاحن سريع', quantity: '1', unitPrice: '650.00' },
            { index: 1, description: 'كابل HDMI', quantity: '2', unitPrice: '600.00' },
          ],
          flagged: false,
        },
      }),
      item(I.inbox.driver, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.driver,
        photos: [{ fileId: cid(46), thumbUrl: null }],
        fieldStatus: extracted(['name', 'brand', 'model', 'type']),
        suggestions: [
          {
            field: 'serial',
            value: '3601JH2000-0472',
            confidence: 0.91,
            source: { extractionId: cid(151), attachmentId: cid(47) },
          },
          {
            field: 'manufactured_on',
            value: '2025-11-14',
            confidence: 0.74,
            source: { extractionId: cid(151), attachmentId: cid(47) },
          },
        ],
        extraction: done(cid(151), 2502, '0.0039', I.call.driver),
      }),
      item(I.inbox.cord, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.cord,
        photos: [{ fileId: cid(48), thumbUrl: null }],
        fieldStatus: extracted(['name', 'type']),
        extraction: done(cid(152), 2380, '0.0031', I.call.cord),
      }),
      item(I.inbox.extinguisher, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.extinguisher,
        photos: [{ fileId: cid(49), thumbUrl: null }],
        fieldStatus: extracted(['name', 'type'], 0.88),
        extraction: done(cid(153), 2410, '0.0032', I.call.extinguisher),
      }),
      item(I.inbox.naming, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.naming,
        photos: [{ fileId: cid(50), thumbUrl: null }],
        extraction: { id: cid(154), status: 'running', call: null },
      }),
      item(I.inbox.failed, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.failed,
        photos: [{ fileId: cid(51), thumbUrl: null }],
        extraction: {
          id: cid(155),
          status: 'failed',
          statusReason: 'provider_error',
          call: null,
        },
      }),
      item(I.inbox.waiting, 'draft', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        thingId: S.waiting,
        photos: [{ fileId: cid(52), thumbUrl: null }],
        extraction: {
          id: cid(156),
          status: 'waiting_provider',
          statusReason: 'rate_limited',
          call: null,
        },
      }),
      item(I.inbox.early, 'draft', L.garage, {
        createdAt: ago(30),
        thingId: S.early,
        photos: [{ fileId: cid(54), thumbUrl: null }],
      }),
      item(I.inbox.aceReceipt, 'receipt', L.garage, {
        createdAt: saturday,
        batchId: I.batch.garageShelves,
        receipt: {
          purchaseId: I.purchase.ace,
          pages: [{ fileId: cid(53), thumbUrl: null }],
          vendorSeen: 'Ace Hardware',
          purchasedOn: '2026-10-03',
          currency: 'EGP',
          total: '5800.00',
          lines: [
            { index: 0, description: 'BOSCH IMPACT DRV', quantity: '1', unitPrice: '4500.00' },
            { index: 1, description: 'EXT CORD 5M 3-WAY', quantity: '1', unitPrice: '350.00' },
            { index: 2, description: 'FIRE EXT 2KG', quantity: '1', unitPrice: '950.00' },
          ],
          flagged: false,
        },
      }),
      item(I.inbox.syncDrop, 'sync_drop', L.home, {
        syncDrop: {
          op: { op: 'move', payload: { thingIds: [T.drill], to: { placeId: P.hallwayCloset } } },
          reason: 'target_trashed',
          entity: { type: 'place', id: P.hallwayCloset, name: 'Hallway closet' },
          by: actor('Alfred'),
        },
      }),
    ],
    aiStatus: {
      [L.home]: {
        resolved: true,
        source: 'account',
        providerKind: RECOMMENDED.kind,
        model: RECOMMENDED.model,
        pausedUntil,
        reason: 'cap_money',
        pausedBy: { scope: 'location', label: 'Home' },
        waitingProvider: null,
        capPercent: 100,
        canResume: true,
        canManage: true,
        modelMissing: false,
        manager: null,
      },
      [L.garage]: {
        resolved: true,
        source: 'account',
        providerKind: RECOMMENDED.kind,
        model: RECOMMENDED.model,
        pausedUntil: null,
        reason: null,
        pausedBy: null,
        // Groq paces one call at a time (D206): a draft waits its turn, with no banner.
        waitingProvider: {
          until: new Date(Date.now() + 20_000).toISOString(),
          reason: 'rate_limited',
        },
        capPercent: 12,
        canResume: false,
        canManage: true,
        modelMissing: false,
        manager: null,
      },
    },
    providers: [
      {
        id: I.provider.account,
        scope: 'account',
        kind: RECOMMENDED.kind,
        label: null,
        baseUrl: null,
        keyHint: 'x7Qa',
        models: { vision: RECOMMENDED.model },
        capabilities: { vision: true, structured: true },
        reasoning: 'low',
        disabled: false,
        rowVersion: 1,
      },
    ],
    caps: [
      {
        id: I.cap.home,
        scope: 'location',
        target: { id: L.home, label: 'Home' },
        task: null,
        monthlyCap: { amount: '5.00', currency: 'USD' },
        used: {
          tokens: 1_612_000,
          cost: [{ currency: 'USD', amount: '5.00' }],
          unknownCostCalls: 2,
        },
        percent: 100,
        state: 'paused',
        pausedUntil,
        reason: 'cap_money',
        cappedByAccount: false,
        rowVersion: 3,
        canEdit: true,
      },
    ],
    prices: [
      {
        providerKind: RECOMMENDED.kind,
        model: RECOMMENDED.model,
        version: 1,
        // Fixture numbers for the screens, not the provider's list price.
        rates: {
          inputPerMtok: '0.10',
          outputPerMtok: '0.30',
          reasoningPerMtok: null,
          cachedInputPerMtok: null,
          perImage: null,
        },
        currency: 'USD',
        effectiveFrom: ago(24 * 20),
        supersededAt: null,
        source: 'admin',
        listingFetchedAt: null,
      },
    ],
    calls: [
      call(I.call.ok, 'extract_thing', 'ok', ago(30), {
        person: me,
        cost: { amount: '0.0030', currency: 'USD', source: 'price_table', priceVersion: 1 },
        links: { thingId: T.drill, extractionId: I.extraction.drill },
      }),
      call(I.call.receipt, 'extract_receipt', 'ok', ago(28), {
        person: me,
        tokens: { estimate: 2800, input: 1917, output: 585, reasoning: 257, cached: 0 },
        cost: { amount: '0.0039', currency: 'USD', source: 'price_table', priceVersion: 1 },
      }),
      call(I.call.label, 'extract_label', 'ok', ago(26), {
        person: { id: I.alfred, name: 'Alfred' },
        tokens: { estimate: 2600, input: 1904, output: 364, reasoning: 253, cached: 0 },
        cost: { amount: '0.0030', currency: 'USD', source: 'price_table', priceVersion: 1 },
      }),
      call(I.call.timeout, 'extract_reading', 'timeout', ago(22), {
        person: me,
        requestId: 'job-odometer',
        location: { id: L.garage, name: 'Garage' },
        paidBy: { scope: 'account', label: 'Garage', fellBack: false },
        tokens: { estimate: 1400, input: null, output: null, reasoning: null, cached: null },
        latencyMs: 80_000,
        finishReason: null,
        errorCode: 'timeout',
      }),
      call(I.call.retry, 'extract_reading', 'ok', ago(21.9), {
        person: me,
        requestId: 'job-odometer',
        attempt: 2,
        location: { id: L.garage, name: 'Garage' },
        paidBy: { scope: 'account', label: 'Garage', fellBack: false },
        tokens: { estimate: 1400, input: 877, output: 194, reasoning: 157, cached: 0 },
        cost: { amount: '0.0015', currency: 'USD', source: 'price_table', priceVersion: 1 },
      }),
      call(I.call.driver, 'extract_thing', 'ok', ago(20), {
        person: me,
        location: { id: L.garage, name: 'Garage' },
        paidBy: { scope: 'account', label: 'Garage', fellBack: false },
        tokens: { estimate: 2600, input: 1990, output: 512, reasoning: 240, cached: 0 },
        cost: { amount: '0.0039', currency: 'USD', source: 'price_table', priceVersion: 1 },
        links: { thingId: S.driver, extractionId: cid(151) },
      }),
      call(I.call.cord, 'extract_thing', 'ok', ago(20), {
        person: me,
        location: { id: L.garage, name: 'Garage' },
        paidBy: { scope: 'account', label: 'Garage', fellBack: false },
        tokens: { estimate: 2600, input: 1960, output: 420, reasoning: 230, cached: 0 },
        cost: { amount: '0.0031', currency: 'USD', source: 'price_table', priceVersion: 1 },
        links: { thingId: S.cord, extractionId: cid(152) },
      }),
      call(I.call.extinguisher, 'extract_thing', 'ok', ago(20), {
        person: me,
        location: { id: L.garage, name: 'Garage' },
        paidBy: { scope: 'account', label: 'Garage', fellBack: false },
        tokens: { estimate: 2600, input: 1970, output: 440, reasoning: 236, cached: 0 },
        cost: { amount: '0.0032', currency: 'USD', source: 'price_table', priceVersion: 1 },
        links: { thingId: S.extinguisher, extractionId: cid(153) },
      }),
      call(I.call.test, 'connection_test', 'ok', ago(24 * 5), {
        person: me,
        location: undefined,
        images: { count: 1, tokensEach: 2048, bytes: 1_204 },
        tokens: { estimate: 1500, input: 1334, output: 10, reasoning: 0, cached: 0 },
        cost: { amount: '0.0011', currency: 'USD', source: 'price_table', priceVersion: 1 },
      }),
      // The instance key (Ollama on the LAN) named a photo in Personal: no price, cost unknown.
      call(I.call.instance, 'extract_thing', 'ok', ago(24 * 3), {
        person: me,
        providerKind: 'openai_compatible',
        model: 'qwen2.5vl:7b',
        location: { id: L.personal, name: 'Personal' },
        // The instance key's label is '' (T9); the web says "This server".
        paidBy: { scope: 'instance', label: '', fellBack: true },
        tokens: { estimate: 2600, input: 1450, output: 220, reasoning: null, cached: null },
      }),
      call(I.call.family, 'extract_thing', 'ok', ago(24 * 2), {
        person: me,
        location: { id: L.family, name: 'بيت العائلة' },
        paidBy: { scope: 'account', label: 'بيت العائلة', fellBack: false },
        cost: { amount: '0.0030', currency: 'USD', source: 'price_table', priceVersion: 1 },
      }),
      call(I.call.paused, 'extract_thing', 'over_budget', ago(3), {
        person: me,
        sent: false,
        tokens: { estimate: 2600, input: null, output: null, reasoning: null, cached: null },
        images: { count: 1, tokensEach: 2048, bytes: null },
        latencyMs: null,
        finishReason: null,
        errorCode: 'cap_money',
        links: { thingId: T.draft, extractionId: I.extraction.draft },
      }),
    ],
    extractions: {
      [T.drill]: [
        {
          id: I.extraction.drill,
          attempt: 1,
          mode: 'thing',
          status: 'succeeded',
          statusReason: null,
          pausedUntil: null,
          createdAt: ago(30),
          model: RECOMMENDED.model,
          applied: ['name', 'type', 'brand'],
          call: {
            id: I.call.ok,
            model: RECOMMENDED.model,
            providerKind: RECOMMENDED.kind,
            tokens: 2557,
            images: 1,
            cost: { amount: '0.0030', currency: 'USD' },
            costSource: 'price_table',
            paidBy: { scope: 'account', label: 'Home', mine: true },
            outcome: 'ok',
          },
        },
      ],
      [T.draft]: [
        {
          id: I.extraction.draft,
          attempt: 1,
          mode: 'thing',
          status: 'paused_budget',
          statusReason: 'cap_money',
          pausedUntil,
          createdAt: ago(3),
          model: RECOMMENDED.model,
          applied: [],
          call: null,
        },
      ],
    },
    labelBatches: [
      {
        id: I.labelBatch.blank,
        locationId: L.home,
        kind: 'blank',
        stock: 'a4_24_70x37',
        startCell: 1,
        createdAt: ago(48),
        printedConfirmedAt: null,
        labels: BLANK_CODES.map((code) => ({ code, url: urlOf(code), kind: 'blank' as const })),
      },
    ],
    codes: [
      ...BLANK_CODES.map((code) => ({
        code,
        locationId: L.home,
        state: 'blank' as const,
        target: null,
        printedAt: null,
      })),
      {
        code: CLAIMED_CODE,
        locationId: L.home,
        state: 'assigned',
        target: { kind: 'thing', id: T.box3, name: 'Box 3' },
        printedAt: ago(48),
      },
    ],
    legacyCodes: [
      {
        locationId: L.garage,
        source: 'homebox',
        code: HOMEBOX_ASSET.unique,
        target: { kind: 'thing', id: T.drill },
      },
      {
        locationId: L.home,
        source: 'homebox',
        code: HOMEBOX_ASSET.ambiguous,
        target: { kind: 'thing', id: T.box3 },
      },
      {
        locationId: L.family,
        source: 'homebox',
        code: HOMEBOX_ASSET.ambiguous,
        target: { kind: 'thing', id: T.arHdmi },
      },
    ],
    imports: [
      {
        id: I.importRun.done,
        locationId: L.home,
        source: 'csv',
        status: 'done',
        mapping: { Name: 'name', Room: 'place_path' },
        choices: {
          placeSeparator: '>',
          createPlaces: true,
          dateFormat: 'DD/MM/YYYY',
          defaultTarget: { unplaced: true },
          typeByName: true,
        },
        progress: 12,
        total: 12,
        createdAt: ago(24 * 6),
        startedAt: ago(24 * 6),
        finishedAt: ago(24 * 6),
        error: null,
        updatedAt: ago(24 * 6),
        rowVersion: 4,
      },
    ],
    templates: [
      {
        id: I.template.storageBox,
        accountId: INV_IDS.account.ibrahim,
        name: 'Storage box',
        typeId: null,
        typeIcon: null,
        payload: { colour: 'Grey', notes: 'Stackable, 40 L' },
        locations: [{ id: L.home, name: 'Home' }],
        rowVersion: 1,
      },
    ],
    undoable: {},
    syncOps: {},
    barcodeLookup: false,
    products: {
      '4006381333931': { name: 'Textmarker', brand: 'Stabilo', quantity: null },
    },
    snapshotPass: 0,
  };
}

function call(
  id: string,
  task: AiCall['task'],
  outcome: AiCall['outcome'],
  at: string,
  extra: Partial<AiCall>,
): AiCall {
  return {
    id,
    at,
    requestId: `job-${id.slice(-4)}`,
    attempt: 1,
    task,
    providerKind: RECOMMENDED.kind,
    model: RECOMMENDED.model,
    location: { id: INV_IDS.loc.home, name: 'Home' },
    person: 'background',
    paidBy: { scope: 'account', label: 'Home', fellBack: false },
    sent: true,
    tokens: { estimate: 2600, input: 1923, output: 376, reasoning: 258, cached: 0 },
    images: { count: 1, tokensEach: 2048, bytes: 412_000 },
    latencyMs: 2140,
    finishReason: 'stop',
    outcome,
    errorCode: null,
    links: {},
    ...extra,
  };
}
