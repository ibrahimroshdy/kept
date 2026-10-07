/**
 * Inventory fixtures for the mock server: Ibrahim's Personal, Home and Garage (English, the screens
 * board's household) and **بيت العائلة**, an Arabic household owned by his brother Bruce where he
 * is a member (EGP, names with harakat and ال, for search and RTL). Built fresh per scenario.
 *
 * Built-in types and place kinds carry `name: null` and a `builtinKey`, as the server sends
 * them; the web translates the key from @kept/shared's library (task 1). Icons are the static set
 * in components/type-icon.tsx.
 */
import type { LocationDetail } from '../../types';
import type {
  Capability,
  FieldKind,
  PlaceKindNode,
  ResolvedField,
  ThingView,
  TypeDetail,
  TypeRef,
} from '../types';
import { type InventoryState, type StoredPlace, type StoredThing, summaryOf } from './db';

const LOC = {
  personal: '01926f00-0000-7000-8000-00000000b001',
  home: '01926f00-0000-7000-8000-00000000b002',
  garage: '01926f00-0000-7000-8000-00000000b003',
  family: '01926f00-0000-7000-8000-00000000b005',
} as const;

const ACCOUNT = {
  ibrahim: '01926f00-0000-7000-8000-0000000ac001',
  bruce: '01926f00-0000-7000-8000-0000000ac002',
} as const;

const pid = (n: number) => `01926f00-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const tid = (n: number) => `01926f00-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const yid = (n: number) => `01926f00-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`;
const rid = (n: number) => `01926f00-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;

/** Ids tests and demo links can use. */
export const INV_IDS = {
  loc: LOC,
  account: ACCOUNT,
  place: {
    homeUnplaced: pid(1),
    livingRoom: pid(2),
    kitchen: pid(3),
    office: pid(4),
    deskDrawer: pid(5),
    hallwayCloset: pid(6),
    bedroom: pid(7),
    garageUnplaced: pid(10),
    toolWall: pid(11),
    shelves: pid(12),
    personalUnplaced: pid(20),
    familyUnplaced: pid(30),
    familyLiving: pid(31),
    familyKitchen: pid(32),
    familyBedroom: pid(33),
  },
  thing: {
    hdmiCable: tid(1),
    cableBox: tid(2),
    tv: tid(3),
    phone: tid(4),
    drill: tid(5),
    car: tid(6),
    safe: tid(7),
    box3: tid(8),
    scarves: tid(9),
    lights: tid(10),
    draft: tid(11),
    kettle: tid(12),
    extinguisher: tid(13),
    batteries: tid(14),
    wallet: tid(20),
    keys: tid(21),
    pump: tid(22),
    brokenLamp: tid(23),
    arHdmi: tid(30),
    arCharger: tid(31),
    arFridge: tid(32),
    arIron: tid(33),
    arBookcase: tid(34),
    arToolbox: tid(35),
    arScrewdriver: tid(36),
  },
  type: {
    furniture: yid(1),
    appliance: yid(2),
    largeAppliance: yid(3),
    electronics: yid(4),
    phone: yid(5),
    tvDisplay: yid(6),
    cable: yid(7),
    charger: yid(8),
    tool: yid(9),
    powerTool: yid(10),
    boxBin: yid(11),
    safe: yid(12),
    vehicle: yid(13),
    car: yid(14),
    safety: yid(15),
    fireExtinguisher: yid(16),
    consumables: yid(17),
    batteries: yid(18),
    device: yid(19),
    smallAppliance: yid(20),
    /** Ibrahim's own custom type. */
    boardGame: yid(50),
  },
  brand: { samsung: rid(1), bosch: rid(2), toshiba: rid(3), toyota: rid(4) },
  vendor: { amazon: rid(10), carrefour: rid(11), bTech: rid(12) },
  person: { alfred: rid(20), peter: rid(21), alfredAr: rid(22) },
  tag: { cables: rid(30), winter: rid(31), kids: rid(32), tools: rid(33) },
  meter: { carOdometer: rid(40) },
} as const;

const I = INV_IDS;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** The Arabic household's location row, added to the step-1 location list (Ibrahim is a member). */
export function familyLocation(): LocationDetail {
  return {
    id: LOC.family,
    name: 'بيت العائلة',
    kind: 'home',
    ownerAccountId: ACCOUNT.bruce,
    role: 'member',
    membershipExpiresAt: null,
    preset: 'household',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    memberCount: 4,
    thingCount: 7,
    pendingInviteCount: 0,
    require2fa: false,
    modules: ['labels', 'money', 'warranties', 'schedules', 'lending', 'paperwork', 'vehicles'],
    providerResolved: false,
  };
}

// ----- types -----------------------------------------------------------------------------------

let fieldSeq = 0;
function field(
  typeId: string,
  key: string,
  kind: FieldKind,
  opts: Partial<ResolvedField> = {},
): ResolvedField {
  fieldSeq += 1;
  return {
    id: `01926f00-0000-7000-8000-0000000fa${String(fieldSeq).padStart(3, '0')}`,
    key,
    label: null,
    labelKey: key,
    kind,
    unit: null,
    options: null,
    repeatable: false,
    required: false,
    secret: false,
    sort: fieldSeq,
    archivedAt: null,
    source: { typeId, via: 'own' },
    rowVersion: 1,
    ...opts,
  } as ResolvedField;
}

function builtin(
  id: string,
  key: string,
  parentId: string | null,
  icon: string,
  capabilities: Capability[],
  extra: Partial<TypeDetail> = {},
): TypeDetail {
  return {
    id,
    parentId,
    builtinKey: key,
    name: null,
    icon,
    colour: null,
    capabilities,
    resolvedCapabilities: capabilities,
    isFieldGroup: false,
    fieldGroups: [],
    copiedFromId: null,
    inUse: 0,
    rowVersion: 1,
    fields: [],
    ...extra,
  };
}

function types(): TypeDetail[] {
  const T = I.type;
  const inherited = (f: ResolvedField): ResolvedField => ({
    ...f,
    source: { typeId: f.source.typeId, via: 'inherited' },
  });
  const group = (f: ResolvedField): ResolvedField => ({
    ...f,
    source: { typeId: f.source.typeId, via: 'group' },
  });
  const deviceFields = [
    field(T.device, 'os', 'text'),
    field(T.device, 'os_version', 'text'),
    field(T.device, 'firmware', 'text'),
    field(T.device, 'mac_address', 'text', { repeatable: true }),
    field(T.device, 'linked_account', 'text', { secret: true }),
  ];
  const vin = field(T.vehicle, 'vin', 'text');
  const cableFields = [
    field(T.cable, 'connector_a', 'text'),
    field(T.cable, 'connector_b', 'text'),
    field(T.cable, 'length', 'number', { unit: 'm' }),
  ];
  const list: TypeDetail[] = [
    builtin(T.furniture, 'furniture', null, 'lucide:sofa', []),
    builtin(T.appliance, 'appliance', null, 'lucide:refrigerator', ['warranty', 'serialized']),
    builtin(T.largeAppliance, 'large_appliance', T.appliance, 'lucide:washing-machine', [], {
      resolvedCapabilities: ['warranty', 'serialized'],
    }),
    builtin(T.smallAppliance, 'small_appliance', T.appliance, 'lucide:microwave', [], {
      resolvedCapabilities: ['warranty', 'serialized'],
    }),
    builtin(T.electronics, 'electronics', null, 'lucide:monitor-smartphone', [
      'warranty',
      'serialized',
    ]),
    builtin(T.phone, 'phone', T.electronics, 'lucide:smartphone', [], {
      resolvedCapabilities: ['warranty', 'serialized'],
      fieldGroups: [T.device],
      fields: [
        field(T.phone, 'imei', 'text'),
        field(T.phone, 'imei_2', 'text'),
        field(T.phone, 'storage', 'text'),
        ...deviceFields.map(group),
      ],
    }),
    builtin(T.tvDisplay, 'tv_display', T.electronics, 'lucide:tv', [], {
      resolvedCapabilities: ['warranty', 'serialized'],
      fieldGroups: [T.device],
      fields: [
        field(T.tvDisplay, 'screen_size', 'number', { unit: 'in' }),
        ...deviceFields.map(group),
      ],
    }),
    builtin(T.cable, 'cable', null, 'lucide:cable', ['consumable'], { fields: cableFields }),
    builtin(T.charger, 'charger', null, 'lucide:plug-zap', [], {
      fields: [
        field(T.charger, 'wattage', 'number', { unit: 'W' }),
        field(T.charger, 'connector', 'text'),
      ],
    }),
    builtin(T.tool, 'tool', null, 'lucide:wrench', ['warranty', 'serialized']),
    builtin(T.powerTool, 'power_tool', T.tool, 'lucide:drill', [], {
      resolvedCapabilities: ['warranty', 'serialized'],
      fields: [
        field(T.powerTool, 'voltage', 'number', { unit: 'V' }),
        field(T.powerTool, 'battery_platform', 'text'),
      ],
    }),
    builtin(T.boxBin, 'box_bin', null, 'lucide:package', ['container']),
    builtin(T.safe, 'safe', null, 'lucide:vault', ['container', 'serialized'], {
      fields: [field(T.safe, 'combination', 'text', { secret: true })],
    }),
    builtin(
      T.vehicle,
      'vehicle',
      null,
      'lucide:car-front',
      ['container', 'metered', 'warranty', 'serialized'],
      {
        defaultMeter: { kind: 'distance', unit: 'km' },
        fields: [vin],
      },
    ),
    builtin(T.car, 'car', T.vehicle, 'lucide:car', [], {
      resolvedCapabilities: ['container', 'metered', 'warranty', 'serialized'],
      defaultMeter: { kind: 'distance', unit: 'km' },
      fields: [inherited(vin), field(T.car, 'plate', 'text')],
    }),
    builtin(T.safety, 'safety_equipment', null, 'lucide:hard-hat', ['expires']),
    builtin(T.fireExtinguisher, 'fire_extinguisher', T.safety, 'lucide:fire-extinguisher', [], {
      resolvedCapabilities: ['expires'],
    }),
    builtin(T.consumables, 'consumables', null, 'lucide:shopping-basket', ['consumable']),
    builtin(T.batteries, 'batteries', T.consumables, 'lucide:battery-full', [], {
      resolvedCapabilities: ['consumable'],
      fields: [field(T.batteries, 'size', 'text'), field(T.batteries, 'chemistry', 'text')],
    }),
    builtin(T.device, 'device', null, 'lucide:cpu', [], {
      isFieldGroup: true,
      fields: deviceFields,
    }),
    {
      ...builtin(T.boardGame, '', null, 'lucide:dices', []),
      builtinKey: null,
      name: 'Board game',
      fields: [
        field(T.boardGame, 'players', 'text', { label: 'Players', labelKey: null }),
        field(T.boardGame, 'complete', 'boolean', { label: 'All pieces there', labelKey: null }),
      ],
    },
  ];
  return list;
}

const typeRef = (all: TypeDetail[], id: string): TypeRef => {
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`fixture type ${id}`);
  return { id: t.id, icon: t.icon, name: t.name, builtinKey: t.builtinKey };
};

function placeKinds(accountId: string): PlaceKindNode[] {
  const kind = (n: number, key: 'floor' | 'room' | 'zone' | 'closet', icon: string) => ({
    id: `01926f00-0000-7000-8000-0000000fb${accountId.slice(-1)}${String(n).padStart(2, '0')}`,
    key,
    builtinKey: key,
    ownerAccountId: null,
    name: null,
    icon,
    fields: [],
    rowVersion: 1,
  });
  return [
    kind(1, 'floor', 'lucide:layers'),
    kind(2, 'room', 'lucide:door-open'),
    kind(3, 'zone', 'lucide:square-dashed'),
    kind(4, 'closet', 'tabler:hanger'),
  ];
}

// ----- places ----------------------------------------------------------------------------------

function place(
  id: string,
  locationId: string,
  name: string,
  kindKey: string,
  parentId: string | null = null,
  extra: Partial<StoredPlace> = {},
): StoredPlace {
  return {
    id,
    locationId,
    parentId,
    name,
    kindKey,
    icon: null,
    isUnplaced: false,
    shortCode: null,
    fields: [],
    custom: {},
    secrets: [],
    rowVersion: 1,
    sort: 0,
    deletedAt: null,
    trashBatchId: null,
    deletedBy: null,
    ...extra,
  };
}

const unplaced = (id: string, locationId: string) =>
  place(id, locationId, 'Unplaced', 'room', null, { isUnplaced: true, sort: -1 });

function places(): StoredPlace[] {
  const P = I.place;
  return [
    unplaced(P.homeUnplaced, LOC.home),
    place(P.livingRoom, LOC.home, 'Living room', 'room', null, { sort: 1 }),
    place(P.kitchen, LOC.home, 'Kitchen', 'room', null, { sort: 2 }),
    place(P.office, LOC.home, 'Office', 'room', null, { sort: 3, shortCode: 'R00M4K' }),
    place(P.deskDrawer, LOC.home, 'Desk drawer', 'zone', P.office),
    place(P.hallwayCloset, LOC.home, 'Hallway closet', 'closet', null, { sort: 4 }),
    place(P.bedroom, LOC.home, 'Bedroom', 'room', null, { sort: 5 }),
    unplaced(P.garageUnplaced, LOC.garage),
    place(P.toolWall, LOC.garage, 'Tool wall', 'zone', null, { sort: 1 }),
    place(P.shelves, LOC.garage, 'Shelves', 'zone', null, { sort: 2 }),
    unplaced(P.personalUnplaced, LOC.personal),
    unplaced(P.familyUnplaced, LOC.family),
    place(P.familyLiving, LOC.family, 'غرفة المعيشة', 'room', null, { sort: 1 }),
    place(P.familyKitchen, LOC.family, 'المطبخ', 'room', null, { sort: 2 }),
    place(P.familyBedroom, LOC.family, 'غرفة النوم', 'room', null, { sort: 3 }),
    place(pid(8), LOC.home, 'Old shelf', 'zone', P.kitchen, {
      deletedAt: ago(3),
      trashBatchId: 'batch-shelf',
      deletedBy: 'Ibrahim',
    }),
  ];
}

// ----- things ----------------------------------------------------------------------------------

function thing(
  all: TypeDetail[],
  id: string,
  locationId: string,
  name: string | null,
  typeId: string | null,
  at: { placeId: string } | { containerId: string },
  extra: Partial<StoredThing> = {},
): StoredThing {
  const base: StoredThing = {
    id,
    locationId,
    shortCode: null,
    name,
    type: typeId ? typeRef(all, typeId) : null,
    quantity: 1,
    lifecycle: 'in_use',
    containerThumbUrl: null,
    thumbUrl: null,
    lastSeenAt: ago(12),
    brand: null,
    model: null,
    serial: null,
    barcode: null,
    colour: null,
    condition: null,
    notes: null,
    aliases: {},
    tags: [],
    belongsTo: null,
    manualUrl: null,
    expiresOn: null,
    expiryLeadDays: null,
    ended: null,
    acquiredFrom: null,
    provenanceNotes: null,
    locationUncertain: false,
    reviewState: 'confirmed',
    fieldStatus: {},
    fields: typeId ? (all.find((t) => t.id === typeId)?.fields ?? []) : [],
    custom: {},
    archivedCustom: {},
    secrets: [],
    placeId: 'placeId' in at ? at.placeId : null,
    containerId: 'containerId' in at ? at.containerId : null,
    isContainer: false,
    purchase: null,
    photos: [],
    attachmentsCount: 0,
    meters: [],
    links: [],
    rowVersion: 1,
    createdAt: ago(40),
    updatedAt: ago(12),
    deletedAt: null,
    trashBatchId: null,
    deletedBy: null,
  };
  return { ...base, ...extra };
}

const tagRef = (id: string, name: string) => ({ id, name, colour: null });

function things(all: TypeDetail[]): StoredThing[] {
  const P = I.place;
  const T = I.thing;
  const Y = I.type;
  const t = (
    id: string,
    locationId: string,
    name: string | null,
    typeId: string | null,
    at: { placeId: string } | { containerId: string },
    extra: Partial<StoredThing> = {},
  ) => thing(all, id, locationId, name, typeId, at, extra);
  const samsung = { id: I.brand.samsung, name: 'Samsung' };
  return [
    t(
      T.cableBox,
      LOC.home,
      'Cable box',
      Y.boxBin,
      { placeId: P.deskDrawer },
      {
        shortCode: 'B0X3QF',
        isContainer: true,
      },
    ),
    t(
      T.hdmiCable,
      LOC.home,
      'HDMI cable, 2 m',
      Y.cable,
      { containerId: T.cableBox },
      {
        shortCode: '7KQ4MZ',
        quantity: 3,
        aliases: { en: ['display cable'] },
        tags: [tagRef(I.tag.cables, 'cables')],
        custom: { connector_a: 'HDMI', connector_b: 'HDMI', length: 2 },
      },
    ),
    t(
      T.tv,
      LOC.home,
      'Samsung TV, 55″',
      Y.tvDisplay,
      { placeId: P.livingRoom },
      {
        shortCode: '5MT0QD',
        brand: samsung,
        model: 'QE55Q60B',
        serial: '0C4H3MAT500123',
        custom: { screen_size: 55 },
        purchase: {
          purchaseId: rid(60),
          purchasedOn: '2025-01-18',
          vendor: { id: I.vendor.bTech, name: 'B.TECH' },
          currency: 'EGP',
          lineDescription: 'Samsung 55" QLED',
          quantity: 1,
          unitPrice: '28999.00',
          receipts: [],
        },
      },
    ),
    t(
      T.phone,
      LOC.home,
      'Galaxy S23',
      Y.phone,
      { placeId: P.homeUnplaced },
      {
        shortCode: 'PH0N3S',
        brand: samsung,
        serial: 'R5CT20ABCDE',
        custom: { imei: '356938035643809', storage: '256 GB', os: 'Android', os_version: '15' },
        secrets: [{ fieldKey: 'linked_account', label: null, set: true, canReveal: true }],
      },
    ),
    t(
      T.drill,
      LOC.garage,
      'Bosch drill, 18 V',
      Y.powerTool,
      { placeId: P.toolWall },
      {
        shortCode: '2HX9RB',
        brand: { id: I.brand.bosch, name: 'Bosch' },
        model: 'GSR 18V-55',
        custom: { voltage: 18, battery_platform: 'Bosch 18V' },
        tags: [tagRef(I.tag.tools, 'tools')],
      },
    ),
    t(
      T.car,
      LOC.garage,
      'Toyota Corolla',
      Y.car,
      { placeId: P.garageUnplaced },
      {
        shortCode: 'CAR7TY',
        brand: { id: I.brand.toyota, name: 'Toyota' },
        custom: { plate: 'س ط ر ١٢٣', vin: 'JTDBR32E720123456' },
        meters: [
          {
            id: I.meter.carOdometer,
            kind: 'distance',
            unit: 'km',
            label: null,
            latest: { value: '52340', takenAt: ago(6) },
            needsReview: 1,
            rowVersion: 1,
          },
        ],
      },
    ),
    t(
      T.safe,
      LOC.home,
      'Wall safe',
      Y.safe,
      { placeId: P.bedroom },
      {
        shortCode: '5AFE9K',
        isContainer: true,
        secrets: [{ fieldKey: 'combination', label: null, set: true, canReveal: true }],
      },
    ),
    t(
      T.box3,
      LOC.home,
      'Box 3',
      Y.boxBin,
      { placeId: P.hallwayCloset },
      {
        shortCode: 'B0X3AA',
        isContainer: true,
      },
    ),
    t(
      T.scarves,
      LOC.home,
      'Winter scarves',
      null,
      { containerId: T.box3 },
      {
        quantity: 4,
        tags: [tagRef(I.tag.winter, 'winter')],
        belongsTo: { id: I.person.peter, displayName: 'Peter' },
      },
    ),
    t(
      T.lights,
      LOC.home,
      'Christmas lights',
      null,
      { containerId: T.box3 },
      {
        locationUncertain: true,
        lastSeenAt: ago(400),
        belongsTo: { id: I.person.alfred, displayName: 'Alfred' },
      },
    ),
    t(T.draft, LOC.home, null, null, { placeId: P.homeUnplaced }, { reviewState: 'draft' }),
    t(
      T.kettle,
      LOC.home,
      'Old kettle',
      Y.smallAppliance,
      { placeId: P.kitchen },
      {
        lifecycle: 'given_away',
        ended: { on: '2026-08-02', to: 'Alfred', notes: null },
      },
    ),
    t(
      T.extinguisher,
      LOC.home,
      'Fire extinguisher',
      Y.fireExtinguisher,
      { placeId: P.kitchen },
      {
        expiresOn: '2027-03-01',
        expiryLeadDays: 30,
      },
    ),
    t(
      T.batteries,
      LOC.home,
      'AA batteries',
      Y.batteries,
      { placeId: P.kitchen },
      {
        quantity: 12,
        custom: { size: 'AA', chemistry: 'Alkaline' },
      },
    ),
    t(T.wallet, LOC.personal, 'Wallet', null, { placeId: P.personalUnplaced }),
    t(
      T.keys,
      LOC.personal,
      'House keys',
      null,
      { placeId: P.personalUnplaced },
      {
        aliases: { en: ['keys'] },
      },
    ),
    t(T.pump, LOC.garage, 'Tyre pump', Y.tool, { placeId: P.shelves }),
    t(
      T.brokenLamp,
      LOC.home,
      'Broken lamp',
      null,
      { placeId: P.bedroom },
      {
        deletedAt: ago(5),
        trashBatchId: 'batch-lamp',
        deletedBy: 'Ibrahim',
      },
    ),
    // بيت العائلة: Arabic names, with harakat and ال (D42, V20).
    t(
      T.arHdmi,
      LOC.family,
      'كابل HDMI',
      Y.cable,
      { placeId: P.familyLiving },
      {
        shortCode: 'AR7HDM',
        aliases: { ar: ['وصلة الشاشة'] },
      },
    ),
    t(
      T.arCharger,
      LOC.family,
      'شاحن سامسونج',
      Y.charger,
      { placeId: P.familyBedroom },
      {
        brand: samsung,
      },
    ),
    t(
      T.arFridge,
      LOC.family,
      'ثلاجة توشيبا',
      Y.largeAppliance,
      { placeId: P.familyKitchen },
      {
        brand: { id: I.brand.toshiba, name: 'توشيبا' },
        shortCode: 'TSH1BA',
      },
    ),
    t(T.arIron, LOC.family, 'مِكْواة البُخار', Y.smallAppliance, { placeId: P.familyUnplaced }),
    t(T.arBookcase, LOC.family, 'المكتبة', Y.furniture, { placeId: P.familyLiving }),
    t(
      T.arToolbox,
      LOC.family,
      'صندوق العدة',
      Y.boxBin,
      { placeId: P.familyKitchen },
      {
        isContainer: true,
        shortCode: 'K7Q3FM',
      },
    ),
    t(
      T.arScrewdriver,
      LOC.family,
      'مفك براغي',
      Y.tool,
      { containerId: T.arToolbox },
      {
        tags: [tagRef(I.tag.tools, 'tools')],
      },
    ),
  ];
}

// ----- the whole state -------------------------------------------------------------------------

export function inventoryFixtures(): InventoryState {
  fieldSeq = 0;
  const allTypes = types();
  const allThings = things(allTypes);
  for (const ty of allTypes)
    ty.inUse = allThings.filter((th) => th.type?.id === ty.id && !th.deletedAt).length;
  const secretValues: Record<string, string> = {
    [`${I.thing.safe}:combination`]: '17-42-08',
    [`${I.thing.phone}:linked_account`]: 'ibrahim@example.com',
  };
  return {
    accounts: [
      { id: ACCOUNT.ibrahim, ownerDisplayName: 'Ibrahim', isOwn: true, canManage: true },
      { id: ACCOUNT.bruce, ownerDisplayName: 'Bruce', isOwn: false, canManage: false },
    ],
    accountOf: {
      [LOC.personal]: ACCOUNT.ibrahim,
      [LOC.home]: ACCOUNT.ibrahim,
      [LOC.garage]: ACCOUNT.ibrahim,
      [LOC.family]: ACCOUNT.bruce,
    },
    types: allTypes,
    placeKinds: {
      [ACCOUNT.ibrahim]: placeKinds(ACCOUNT.ibrahim),
      [ACCOUNT.bruce]: placeKinds(ACCOUNT.bruce),
    },
    brands: [
      {
        id: I.brand.samsung,
        ownerAccountId: null,
        name: 'Samsung',
        website: 'https://www.samsung.com',
        supportPhone: '19400',
        claimUrl: null,
        defaultWarrantyMonths: 24,
        rowVersion: 1,
      },
      {
        id: I.brand.bosch,
        ownerAccountId: null,
        name: 'Bosch',
        website: 'https://www.bosch.com',
        supportPhone: null,
        claimUrl: null,
        defaultWarrantyMonths: 24,
        rowVersion: 1,
      },
      {
        id: I.brand.toshiba,
        ownerAccountId: ACCOUNT.bruce,
        name: 'توشيبا',
        website: null,
        supportPhone: null,
        claimUrl: null,
        defaultWarrantyMonths: 12,
        rowVersion: 1,
      },
      {
        id: I.brand.toyota,
        ownerAccountId: null,
        name: 'Toyota',
        website: null,
        supportPhone: null,
        claimUrl: null,
        defaultWarrantyMonths: 36,
        rowVersion: 1,
      },
    ],
    vendors: [
      {
        id: I.vendor.amazon,
        ownerAccountId: ACCOUNT.ibrahim,
        name: 'Amazon.eg',
        kind: 'online',
        address: null,
        phone: null,
        website: 'https://www.amazon.eg',
        rowVersion: 1,
      },
      {
        id: I.vendor.carrefour,
        ownerAccountId: ACCOUNT.bruce,
        name: 'كارفور',
        kind: 'store',
        address: 'سيتي ستارز',
        phone: null,
        website: null,
        rowVersion: 1,
      },
      {
        id: I.vendor.bTech,
        ownerAccountId: ACCOUNT.ibrahim,
        name: 'B.TECH',
        kind: 'store',
        address: null,
        phone: '19966',
        website: null,
        rowVersion: 1,
      },
    ],
    people: [
      {
        id: I.person.alfred,
        ownerAccountId: ACCOUNT.ibrahim,
        displayName: 'Alfred',
        userId: 'u-alfred',
        rowVersion: 1,
      },
      {
        id: I.person.peter,
        ownerAccountId: ACCOUNT.ibrahim,
        displayName: 'Peter',
        userId: 'u-peter',
        rowVersion: 1,
      },
      {
        id: I.person.alfredAr,
        ownerAccountId: ACCOUNT.bruce,
        displayName: 'ألفريد',
        userId: null,
        rowVersion: 1,
      },
    ],
    tags: [
      {
        id: I.tag.cables,
        ownerAccountId: ACCOUNT.ibrahim,
        name: 'cables',
        colour: null,
        rowVersion: 1,
      },
      {
        id: I.tag.winter,
        ownerAccountId: ACCOUNT.ibrahim,
        name: 'winter',
        colour: null,
        rowVersion: 1,
      },
      {
        id: I.tag.kids,
        ownerAccountId: ACCOUNT.ibrahim,
        name: 'kids',
        colour: null,
        rowVersion: 1,
      },
      {
        id: I.tag.tools,
        ownerAccountId: ACCOUNT.bruce,
        name: 'tools',
        colour: null,
        rowVersion: 1,
      },
    ],
    currencies: [
      { code: 'EGP', name: 'Egyptian pound', minorUnits: 2, symbol: 'ج.م.', enabled: true },
      { code: 'USD', name: 'US dollar', minorUnits: 2, symbol: '$', enabled: true },
      { code: 'EUR', name: 'Euro', minorUnits: 2, symbol: '€', enabled: true },
      { code: 'GBP', name: 'British pound', minorUnits: 2, symbol: '£', enabled: true },
      { code: 'CAD', name: 'Canadian dollar', minorUnits: 2, symbol: 'CA$', enabled: true },
      { code: 'SAR', name: 'Saudi riyal', minorUnits: 2, symbol: 'ر.س.', enabled: false },
      { code: 'JPY', name: 'Japanese yen', minorUnits: 0, symbol: '¥', enabled: false },
    ],
    places: places(),
    things: allThings,
    purchases: [],
    readings: {
      [I.meter.carOdometer]: [
        {
          id: rid(41),
          value: '51200',
          takenAt: ago(40),
          source: 'manual',
          state: 'accepted',
          reviewReason: null,
          loggedBy: { displayName: 'Ibrahim' },
          note: null,
          rowVersion: 1,
        },
        {
          id: rid(42),
          value: '52340',
          takenAt: ago(6),
          source: 'manual',
          state: 'accepted',
          reviewReason: null,
          loggedBy: { displayName: 'Ibrahim' },
          note: null,
          rowVersion: 1,
        },
        {
          id: rid(43),
          value: '5234',
          takenAt: ago(2),
          source: 'manual',
          state: 'needs_review',
          reviewReason: 'lower_than_previous',
          loggedBy: { displayName: 'Alfred' },
          note: null,
          rowVersion: 1,
        },
      ],
    },
    files: {},
    attachments: [],
    savedViews: [],
    savedViewPrefs: {},
    events: [
      event(
        1,
        'thing.create',
        'thing',
        I.thing.hdmiCable,
        LOC.home,
        'Ibrahim',
        'HDMI cable, 2 m',
        0.5,
      ),
      event(2, 'thing.move', 'thing', I.thing.box3, LOC.home, 'Alfred', 'Box 3', 1),
      event(3, 'thing.update', 'thing', I.thing.tv, LOC.home, 'Bruce', 'Samsung TV, 55″', 2, {
        model: { before: 'QE55Q60A', after: 'QE55Q60B', class: 'plain' },
      }),
      event(4, 'thing.create', 'thing', I.thing.arHdmi, LOC.family, 'بروس', 'كابل HDMI', 3),
      event(5, 'place.create', 'place', I.place.office, LOC.home, 'Ibrahim', 'Office', 9),
      event(6, 'thing.trash', 'thing', I.thing.brokenLamp, LOC.home, 'Ibrahim', 'Broken lamp', 5),
    ],
    hints: [],
    checklistDismissed: false,
    secrets: secretValues,
  };
}

function event(
  n: number,
  action: string,
  entityType: string,
  entityId: string,
  locationId: string,
  actor: string,
  /** What it's about, as the summary names it. */
  name: string,
  daysAgo: number,
  diff: Record<string, { before: unknown; after: unknown; class: 'plain' | 'money' }> | null = null,
) {
  return {
    id: `01926f00-0000-7000-8000-0000000ee${String(n).padStart(3, '0')}`,
    at: ago(daysAgo),
    location_id: locationId,
    action,
    actor: { type: 'user', id: null, displayName: actor },
    entity: { type: entityType, id: entityId },
    root_thing_id: entityType === 'thing' ? entityId : null,
    diff,
    undo_of: null,
    undoable_until: null,
    ...summaryOf(action, name),
  };
}

/** A thing's full view type, re-exported for handler modules. */
export type { ThingView };
