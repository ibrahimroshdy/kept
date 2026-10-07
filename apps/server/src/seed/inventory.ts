import type { LinkKind } from '@kept/shared';
import type { PersonKey } from './cast.js';

// What the households hold (task 23; D152, D185): the screens board's sample inventory
// (docs/design/screens/*.html) and the web mock's (apps/web/src/api/inventory/mock/fixtures.ts),
// made through the real routes by seed/stock.ts. Names are the natural keys the seed looks
// things up by on a second run, so each is unique within its location (and a place's within
// its parent).
//
// Short IDs are the board's where it shows one: the HDMI cable 7KQ‑4MZ in the Cable box 3CB‑8WN,
// the Samsung TV 5MT‑0QD, the Wi‑Fi router 9RT‑2FK, the Bosch drill 2HX‑9RB, the Corolla 4VC‑7HD.
// The board reuses a few codes for two things; the seed keeps each code for one of them.
//
// Left out on purpose: lending (the drill "with Murdock" is step 4), drafts (capture is step 3),
// trashed things (a seed that trashes has nothing to show a second time), and places' custom
// fields (no built-in place kind carries one).

/** Where a location's thing sits: a place path under the location's top level, Unplaced, or
 * inside another thing of the same list (a container, by its `key`). */
export type At = { place: readonly string[] } | { in: string } | 'unplaced';

export type PlaceSpec = {
  name: string;
  kind: 'floor' | 'room' | 'zone' | 'closet';
  /** A fixed short ID for the place's label (D112), as on the board. */
  code?: string;
  children?: readonly PlaceSpec[];
};

export type ReadingSpec = {
  value: string;
  daysAgo: number;
  by: PersonKey;
};

export type ThingSpec = {
  /** The seed's handle for links, containers and receipts; not stored. */
  key: string;
  name: string;
  /** A built-in type's key, or `custom:<name>` for one of the account's own types. */
  type?: string;
  at: At;
  /** Who adds it (a member of the location with things.edit); the owner by default. */
  by?: PersonKey;
  quantity?: number;
  brand?: string;
  model?: string;
  serial?: string;
  colour?: string;
  condition?: 'new' | 'good' | 'fair' | 'poor' | 'broken';
  notes?: string;
  aliases?: Record<string, string[]>;
  tags?: readonly string[];
  belongsTo?: string;
  expiresOn?: string;
  expiryLeadDays?: number;
  custom?: Record<string, unknown>;
  /** A fixed short ID (D112), as on the board. */
  code?: string;
  /** A one-line purchase made with the thing (things' `purchase`): the price of one. */
  bought?: { on: string; vendor?: string; currency: string; price: string };
  /** A photo: a small JPEG of this colour, uploaded through the files route. */
  photo?: string;
  /** A secret field's value (T19's route), e.g. the router's Wi-Fi password. */
  secret?: { field: string; value: string };
  ended?: { lifecycle: 'given_away' | 'sold'; on: string; to?: string };
  notHere?: boolean;
  link?: { to: string; kind: LinkKind };
  /** Readings of the type's default meter (a car starts with its odometer, D113). */
  readings?: readonly ReadingSpec[];
};

export type ReceiptSpec = {
  /** A handle for the report; the purchase is found again through its first line's thing. */
  key: string;
  vendor: string;
  purchasedOn: string;
  currency: string;
  total: string;
  tax?: string;
  notes?: string;
  by?: PersonKey;
  lines: readonly { description: string; quantity?: number; unitPrice: string; thing: string }[];
  /** The receipt photo's colour (an evidence-class JPEG, D117). */
  photo: string;
};

export type SavedViewSpec = {
  name: string;
  by: PersonKey;
  /** Shared with this location (by name), or personal. */
  shared?: boolean;
  query: { q?: string; state?: 'uncertain' | 'draft' | 'ended' | 'to_review' | 'unplaced' };
  /** A tag of the location's account, by name (becomes `tagId`). */
  tag?: string;
};

export type CustomTypeSpec = {
  name: string;
  icon: string;
  capabilities: readonly ('container' | 'consumable' | 'warranty' | 'serialized' | 'expires')[];
  fields: readonly {
    key: string;
    label: string;
    kind: 'text' | 'number' | 'boolean';
    unit?: string;
  }[];
};

/** An owner's account registries, shared by every location of the account (D11). */
export type AccountStock = {
  brands: readonly {
    name: string;
    website?: string;
    supportPhone?: string;
    defaultWarrantyMonths?: number;
  }[];
  vendors: readonly {
    name: string;
    kind: 'store' | 'online' | 'service_centre';
    address?: string;
    phone?: string;
    website?: string;
  }[];
  people: readonly string[];
  tags: readonly { name: string; colour?: string }[];
  types: readonly CustomTypeSpec[];
};

export type LocationStock = {
  /** A household's name (cast.ts), or `personal` for the owner's Personal location. */
  location: string;
  owner: PersonKey;
  /** Modules switched on beyond the preset (the router's and the safe's secrets). */
  modules?: readonly string[];
  places: readonly PlaceSpec[];
  things: readonly ThingSpec[];
  receipts?: readonly ReceiptSpec[];
  views?: readonly SavedViewSpec[];
};

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export const ACCOUNT_STOCK: Partial<Record<PersonKey, AccountStock>> = {
  ibrahim: {
    brands: [
      {
        name: 'Samsung',
        website: 'https://www.samsung.com',
        supportPhone: '19400',
        defaultWarrantyMonths: 24,
      },
      { name: 'Bosch', website: 'https://www.bosch.com', defaultWarrantyMonths: 24 },
      { name: 'Toyota', defaultWarrantyMonths: 36 },
      { name: 'TP-Link', website: 'https://www.tp-link.com', defaultWarrantyMonths: 36 },
      { name: 'Lenovo', defaultWarrantyMonths: 12 },
      { name: 'Sony', defaultWarrantyMonths: 12 },
      { name: 'IKEA' },
    ],
    vendors: [
      { name: 'B.TECH', kind: 'store', phone: '19966' },
      { name: 'Amazon.eg', kind: 'online', website: 'https://www.amazon.eg' },
      { name: 'Ace Hardware', kind: 'store', address: 'Cairo Festival City' },
      { name: 'Samsung Service Centre', kind: 'service_centre', phone: '19400' },
    ],
    people: ['Alfred', 'Peter', 'Murdock'],
    tags: [
      { name: 'cables' },
      { name: 'winter' },
      { name: 'kids' },
      { name: 'tools' },
      { name: 'ramadan' },
    ],
    types: [
      {
        name: 'Board game',
        icon: 'lucide:dices',
        capabilities: [],
        fields: [
          { key: 'players', label: 'Players', kind: 'text' },
          { key: 'complete', label: 'All pieces there', kind: 'boolean' },
        ],
      },
    ],
  },
  alfred: {
    brands: [{ name: 'توشيبا', defaultWarrantyMonths: 12 }, { name: 'سامسونج' }],
    vendors: [{ name: 'كارفور', kind: 'store', address: 'سيتي ستارز' }],
    people: ['جَدّتي'],
    tags: [{ name: 'أدوات' }, { name: 'رمضان' }],
    types: [],
  },
};

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

const HOME: LocationStock = {
  location: 'Home',
  owner: 'ibrahim',
  modules: ['secrets'],
  // The Apartment and House templates (screens §8): living room, kitchen, two bedrooms, a
  // bathroom and a balcony, then a hallway and a storage room; with the board's office.
  places: [
    {
      name: 'Living room',
      kind: 'room',
      children: [
        { name: 'TV unit', kind: 'zone', children: [{ name: 'Left drawer', kind: 'zone' }] },
      ],
    },
    { name: 'Kitchen', kind: 'room', children: [{ name: 'Pantry', kind: 'closet' }] },
    { name: 'Office', kind: 'room', children: [{ name: 'Desk drawer', kind: 'zone' }] },
    { name: 'Bedroom', kind: 'room', children: [{ name: 'Wardrobe', kind: 'closet' }] },
    { name: "Peter's room", kind: 'room' },
    { name: 'Bathroom', kind: 'room' },
    { name: 'Balcony', kind: 'zone' },
    { name: 'Hallway', kind: 'room', children: [{ name: 'Hallway closet', kind: 'closet' }] },
    { name: 'Storage room', kind: 'room' },
  ],
  things: [
    // Living room
    {
      key: 'tv',
      name: 'Samsung TV, 55″',
      type: 'tv_display',
      at: { place: ['Living room', 'TV unit'] },
      brand: 'Samsung',
      model: 'QE55Q60B',
      serial: '0C4H3MAT500123',
      code: '5MT0QD',
      custom: { screen_size: 55, os: 'Tizen' },
      photo: '#2f3b52',
    },
    {
      key: 'router',
      name: 'Wi-Fi router',
      type: 'network_device',
      at: { place: ['Living room', 'TV unit'] },
      brand: 'TP-Link',
      model: 'Archer AX55',
      serial: '22391A7000412',
      code: '9RT2FK',
      custom: { firmware: '1.3.2', mac_address: ['3C:52:A1:7E:10:4B', '3C:52:A1:7E:10:4C'] },
      secret: { field: 'wifi_password', value: 'olive-kettle-42' },
      bought: { on: '2025-06-02', vendor: 'Amazon.eg', currency: 'EGP', price: '4250.00' },
      photo: '#e8e4dc',
    },
    {
      key: 'switch',
      name: 'Network switch, 4-port',
      type: 'network_device',
      at: { place: ['Living room', 'TV unit'] },
      brand: 'TP-Link',
      link: { to: 'router', kind: 'accessory_of' },
    },
    {
      key: 'displayCable',
      name: 'Display cable, 1.8 m',
      type: 'cable',
      at: { place: ['Living room', 'TV unit', 'Left drawer'] },
      aliases: { en: ['hdmi', 'video cable'] },
      tags: ['cables'],
      custom: { connector_a: 'HDMI', connector_b: 'HDMI', length: 1.8 },
    },
    {
      key: 'ps5',
      name: 'PlayStation 5',
      type: 'console',
      at: { place: ['Living room', 'TV unit'] },
      brand: 'Sony',
      serial: 'E-CFI1216A-0071',
      link: { to: 'tv', kind: 'accessory_of' },
    },
    {
      key: 'sofa',
      name: 'Sofa',
      type: 'furniture',
      at: { place: ['Living room'] },
      brand: 'IKEA',
      colour: 'Grey',
    },
    {
      key: 'catan',
      name: 'Catan',
      type: 'custom:Board game',
      at: { place: ['Living room'] },
      custom: { players: '3–4', complete: true },
      tags: ['kids'],
    },
    {
      key: 'monopoly',
      name: 'Monopoly',
      type: 'custom:Board game',
      at: { place: ['Living room'] },
      custom: { players: '2–6', complete: false },
      notes: 'Two of the hotels are missing.',
    },
    // Office
    {
      key: 'laptop',
      name: 'ThinkPad T14',
      type: 'computer',
      at: { place: ['Office'] },
      brand: 'Lenovo',
      serial: 'PF3ZK9QA',
      custom: { cpu: 'Ryzen 7 7840U', ram: '32 GB', storage: '1 TB', os: 'Linux' },
      bought: { on: '2024-11-20', vendor: 'Amazon.eg', currency: 'EGP', price: '61500.00' },
      photo: '#3a3a3a',
    },
    {
      key: 'cableBox',
      name: 'Cable box',
      type: 'box_bin',
      at: { place: ['Office', 'Desk drawer'] },
      code: '3CB8WN',
    },
    {
      key: 'hdmi',
      name: 'HDMI cable, 2 m',
      type: 'cable',
      at: { in: 'cableBox' },
      quantity: 3,
      aliases: { en: ['display cable'] },
      tags: ['cables'],
      code: '7KQ4MZ',
      custom: { connector_a: 'HDMI', connector_b: 'HDMI', length: 2 },
      link: { to: 'tv', kind: 'accessory_of' },
    },
    {
      key: 'usbc',
      name: 'USB-C charger, 65 W',
      type: 'charger',
      at: { in: 'cableBox' },
      brand: 'Samsung',
      custom: { wattage: 65, connector: 'USB-C' },
      link: { to: 'laptop', kind: 'accessory_of' },
    },
    {
      key: 'lightning',
      name: 'Lightning cable, 1 m',
      type: 'cable',
      at: { in: 'cableBox' },
      quantity: 2,
      tags: ['cables'],
      custom: { connector_a: 'USB-A', connector_b: 'Lightning', length: 1 },
    },
    // Unplaced: the phone, with its device fields (D192).
    {
      key: 'phone',
      name: 'Galaxy S23',
      type: 'phone',
      at: 'unplaced',
      brand: 'Samsung',
      serial: 'R5CT20ABCDE',
      custom: { imei: '356938035643809', storage: '256 GB', os: 'Android', os_version: '15' },
      photo: '#1d2733',
    },
    // Kitchen
    {
      key: 'fridge',
      name: 'Fridge',
      type: 'large_appliance',
      at: { place: ['Kitchen'] },
      brand: 'Samsung',
      model: 'RT42CG6000',
      serial: '0AB24KRT900281',
    },
    {
      key: 'kettle',
      name: 'Old kettle',
      type: 'small_appliance',
      at: { place: ['Kitchen'] },
      by: 'bruce',
      ended: { lifecycle: 'given_away', on: '2026-08-02', to: 'Alfred' },
    },
    {
      key: 'extinguisher',
      name: 'Fire extinguisher, 2 kg',
      type: 'fire_extinguisher',
      at: { place: ['Kitchen'] },
      expiresOn: '2027-03-01',
      expiryLeadDays: 30,
    },
    {
      key: 'batteries',
      name: 'AA batteries',
      type: 'batteries',
      at: { place: ['Kitchen', 'Pantry'] },
      quantity: 12,
      custom: { size: 'AA', chemistry: 'Alkaline' },
    },
    {
      key: 'filter',
      name: 'Water filter cartridge',
      type: 'filters',
      at: { place: ['Kitchen'] },
      expiresOn: '2026-10-20',
      expiryLeadDays: 14,
    },
    {
      key: 'smoke',
      name: 'Smoke alarm',
      type: 'smoke_detector',
      at: { place: ['Hallway'] },
      expiresOn: '2031-05-01',
    },
    // Bedroom: the safe and what is in it.
    {
      key: 'safe',
      name: 'Wall safe',
      type: 'safe',
      at: { place: ['Bedroom', 'Wardrobe'] },
      serial: 'YS-2024-11873',
      secret: { field: 'combination', value: '17-42-08' },
    },
    { key: 'passports', name: 'Passports folder', at: { in: 'safe' } },
    {
      key: 'watch',
      name: "Grandfather's watch",
      type: 'valuables',
      at: { in: 'safe' },
      notes: 'Wind it once a month.',
    },
    // Peter's room
    {
      key: 'switchConsole',
      name: 'Nintendo Switch',
      type: 'console',
      at: { place: ["Peter's room"] },
      belongsTo: 'Peter',
      tags: ['kids'],
      by: 'alfred',
    },
    {
      key: 'lego',
      name: 'Lego city set',
      at: { place: ["Peter's room"] },
      belongsTo: 'Peter',
      tags: ['kids'],
      condition: 'good',
    },
    // Bathroom and balcony
    {
      key: 'firstAid',
      name: 'First aid kit',
      type: 'first_aid_kit',
      at: { place: ['Bathroom'] },
      expiresOn: '2027-01-15',
    },
    { key: 'dryer', name: 'Hair dryer', type: 'small_appliance', at: { place: ['Bathroom'] } },
    {
      key: 'bike',
      name: 'City bike',
      type: 'bicycle',
      at: { place: ['Balcony'] },
      colour: 'Green',
      custom: { frame_number: 'WTU214C8812' },
    },
    // Hallway closet: Box 3 and what it holds.
    { key: 'box3', name: 'Box 3', type: 'box_bin', at: { place: ['Hallway', 'Hallway closet'] } },
    {
      key: 'scarves',
      name: 'Winter scarves',
      at: { in: 'box3' },
      quantity: 4,
      tags: ['winter'],
      belongsTo: 'Peter',
    },
    {
      key: 'lights',
      name: 'Christmas lights',
      at: { in: 'box3' },
      belongsTo: 'Alfred',
      tags: ['winter'],
      notHere: true,
    },
    // Storage room: the Ramadan box and the toolbox, as on the label sheet (screens 03).
    {
      key: 'ramadanBox',
      name: 'Ramadan decorations box',
      type: 'box_bin',
      at: { place: ['Storage room'] },
      code: '3RD6FX',
      tags: ['ramadan'],
    },
    {
      key: 'lantern',
      name: 'Ramadan lantern',
      at: { in: 'ramadanBox' },
      aliases: { ar: ['فانوس'] },
      tags: ['ramadan'],
    },
    {
      key: 'toolbox',
      name: 'Toolbox',
      type: 'box_bin',
      at: { place: ['Storage room'] },
      code: '8TB4WQ',
    },
    {
      key: 'screwdrivers',
      name: 'Screwdriver set',
      type: 'tool',
      at: { in: 'toolbox' },
      tags: ['tools'],
    },
  ],
  // A B.TECH receipt with two lines (the TV and the HDMI cables) and its photo (D117).
  receipts: [
    {
      key: 'btech',
      vendor: 'B.TECH',
      purchasedOn: '2025-01-18',
      currency: 'EGP',
      total: '29449.00',
      notes: 'Paid in 12 instalments.',
      lines: [
        { description: 'Samsung 55" QLED Q60B', unitPrice: '28999.00', thing: 'tv' },
        { description: 'HDMI cable 2 m', quantity: 3, unitPrice: '150.00', thing: 'hdmi' },
      ],
      photo: '#f4f1ea',
    },
  ],
  views: [
    { name: 'Cables', by: 'ibrahim', query: { q: 'cable' } },
    { name: 'Needs a look', by: 'ibrahim', shared: true, query: { state: 'uncertain' } },
    { name: "Peter's things", by: 'alfred', shared: true, query: {}, tag: 'kids' },
  ],
};

const GARAGE: LocationStock = {
  location: 'Garage',
  owner: 'ibrahim',
  // The Garage template (screens §8: tool wall, shelves, floor), named as on the board.
  places: [
    { name: 'Tool wall', kind: 'zone' },
    { name: 'Shelf A', kind: 'zone', code: '7SH2AA' },
    { name: 'Shelf B', kind: 'zone' },
    { name: 'Bay 1', kind: 'zone' },
    { name: 'Bay 2', kind: 'zone' },
  ],
  things: [
    {
      key: 'corolla',
      name: 'Toyota Corolla',
      type: 'car',
      at: { place: ['Bay 2'] },
      brand: 'Toyota',
      model: 'Corolla 1.6 XLi',
      code: '4VC7HD',
      custom: { plate: 'س ط ر ١٢٣', vin: 'JTDBR32E720123456' },
      photo: '#9aa3ad',
      // The third is Alfred's typo (an extra digit): an implausible jump, held for review (D26).
      readings: [
        { value: '51200', daysAgo: 40, by: 'ibrahim' },
        { value: '52340', daysAgo: 6, by: 'alfred' },
        { value: '523400', daysAgo: 1, by: 'alfred' },
      ],
    },
    { key: 'jack', name: 'Car jack', type: 'tool', at: { in: 'corolla' } },
    {
      key: 'drill',
      name: 'Bosch drill, 18 V',
      type: 'power_tool',
      at: { place: ['Tool wall'] },
      brand: 'Bosch',
      model: 'GSR 18V-55',
      code: '2HX9RB',
      tags: ['tools'],
      custom: { voltage: 18, battery_platform: 'Bosch 18V' },
      bought: { on: '2025-03-14', vendor: 'Ace Hardware', currency: 'EGP', price: '3450.00' },
      photo: '#1f5f8b',
    },
    {
      key: 'impact',
      name: 'Bosch impact driver, 18 V',
      type: 'power_tool',
      at: { place: ['Tool wall'] },
      brand: 'Bosch',
      tags: ['tools'],
      custom: { voltage: 18, battery_platform: 'Bosch 18V' },
    },
    {
      key: 'hammer',
      name: 'Claw hammer',
      type: 'tool',
      at: { place: ['Tool wall'] },
      tags: ['tools'],
    },
    { key: 'pump', name: 'Tyre pump', type: 'tool', at: { place: ['Shelf A'] } },
    { key: 'roller', name: 'Paint roller set', at: { place: ['Shelf A'] } },
    {
      key: 'cord10',
      name: 'Extension cord, 10 m',
      type: 'cable',
      at: { place: ['Shelf A'] },
      custom: { length: 10 },
    },
    { key: 'bits', name: 'Bosch drill bit set', at: { place: ['Shelf B'] }, brand: 'Bosch' },
    { key: 'hose', name: 'Garden hose, 15 m', at: { place: ['Shelf B'] } },
    { key: 'box7', name: 'Box 7', type: 'box_bin', at: { place: ['Shelf B'] } },
    {
      key: 'hdmi5',
      name: 'HDMI cable, 5 m',
      type: 'cable',
      at: { in: 'box7' },
      tags: ['cables'],
      custom: { connector_a: 'HDMI', connector_b: 'HDMI', length: 5 },
      notHere: true,
      by: 'alfred',
    },
  ],
};

const PERSONAL: LocationStock = {
  location: 'personal',
  owner: 'ibrahim',
  places: [],
  things: [
    { key: 'wallet', name: 'Wallet', at: 'unplaced' },
    { key: 'keys', name: 'House keys', at: 'unplaced', aliases: { en: ['keys'] } },
  ],
};

// بيت العائلة: Arabic names with harakat and ال, for search (D42) and right-to-left layouts.
const FAMILY: LocationStock = {
  location: 'بيت العائلة',
  owner: 'alfred',
  places: [
    { name: 'غرفة المعيشة', kind: 'room' },
    { name: 'المطبخ', kind: 'room', children: [{ name: 'الخزانة العلوية', kind: 'closet' }] },
    { name: 'غرفة النوم', kind: 'room' },
    { name: 'الحمّام', kind: 'room' },
    { name: 'الشُّرفة', kind: 'zone' },
  ],
  things: [
    {
      key: 'arHdmi',
      name: 'كابل HDMI',
      type: 'cable',
      at: { place: ['غرفة المعيشة'] },
      aliases: { ar: ['وصلة الشاشة'] },
      custom: { connector_a: 'HDMI', connector_b: 'HDMI', length: 3 },
    },
    {
      key: 'arTv',
      name: 'تلفزيون توشيبا',
      type: 'tv_display',
      at: { place: ['غرفة المعيشة'] },
      brand: 'توشيبا',
      custom: { screen_size: 43 },
      photo: '#26323f',
    },
    { key: 'arBookcase', name: 'المكتبة', type: 'furniture', at: { place: ['غرفة المعيشة'] } },
    {
      key: 'arFridge',
      name: 'ثلاجة توشيبا',
      type: 'large_appliance',
      at: { place: ['المطبخ'] },
      brand: 'توشيبا',
      serial: 'GR-RT624WE-PMN',
    },
    {
      key: 'arIron',
      name: 'مِكْواة البُخار',
      type: 'small_appliance',
      at: 'unplaced',
      by: 'bruce',
    },
    {
      key: 'arToolbox',
      name: 'صندوق العدّة',
      type: 'box_bin',
      at: { place: ['المطبخ', 'الخزانة العلوية'] },
    },
    {
      key: 'arScrewdriver',
      name: 'مِفَكّ براغي',
      type: 'tool',
      at: { in: 'arToolbox' },
      tags: ['أدوات'],
    },
    { key: 'arHammer', name: 'الشاكوش', type: 'tool', at: { in: 'arToolbox' }, tags: ['أدوات'] },
    {
      key: 'arCharger',
      name: 'شاحن سامسونج',
      type: 'charger',
      at: { place: ['غرفة النوم'] },
      brand: 'سامسونج',
      custom: { wattage: 25 },
    },
    {
      key: 'arLantern',
      name: 'فَانُوس رَمَضَان',
      at: { place: ['الشُّرفة'] },
      tags: ['رمضان'],
      belongsTo: 'جَدّتي',
    },
    {
      key: 'arKettle',
      name: 'الغلاية الكهربائية',
      type: 'small_appliance',
      at: { place: ['المطبخ'] },
    },
  ],
  receipts: [
    {
      key: 'carrefour',
      vendor: 'كارفور',
      purchasedOn: '2026-02-11',
      currency: 'EGP',
      total: '19950.00',
      lines: [
        { description: 'ثلاجة توشيبا ١٨ قدم', unitPrice: '18500.00', thing: 'arFridge' },
        { description: 'مكواة بخار', unitPrice: '1450.00', thing: 'arIron' },
      ],
      photo: '#fbfaf5',
    },
  ],
  views: [{ name: 'الأدوات', by: 'alfred', shared: true, query: {}, tag: 'أدوات' }],
};

export const LOCATION_STOCK: readonly LocationStock[] = [HOME, GARAGE, PERSONAL, FAMILY];
