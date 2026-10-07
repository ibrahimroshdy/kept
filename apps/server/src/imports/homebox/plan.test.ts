import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HomeboxChoices, newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestFiles, testFiles } from '../../../test/files.js';
import { importArchiveKey } from '../../storage/blob-store.js';
import type { HbLookups } from './lookups.js';
import { type HbOp, planHomebox, type ThingOp } from './plan.js';
import { type HomeboxData, openHomebox, readHomebox } from './read.js';

// T9: the Homebox mapping over spike H1's two real exports (test/fixtures/homebox/README.md),
// planned against hand-made lookups: no database, the planner is pure.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'homebox',
);

let files: TestFiles;
let home: HomeboxData;
let family: HomeboxData;

async function read(name: 'home' | 'family'): Promise<HomeboxData> {
  const runId = newId();
  const file = path.join(FIXTURES, `homebox-0.26.2-${name}.zip`);
  const { stat } = await import('node:fs/promises');
  const bytes = (await stat(file)).size;
  await files.blobs.put(importArchiveKey(runId), file, { contentType: 'application/zip', bytes });
  const archive = await openHomebox(files.blobs, importArchiveKey(runId), bytes);
  try {
    return await readHomebox(archive);
  } finally {
    archive.close();
  }
}

const BOX = '00000000-0000-7000-8000-00000000b0b0';
const APPLIANCE = '00000000-0000-7000-8000-0000000000a1';
const TOOL = '00000000-0000-7000-8000-0000000000a2';
const UNPLACED = '00000000-0000-7000-8000-0000000000aa';

function lookups(over: Partial<HbLookups> = {}): HbLookups {
  return {
    locationId: '00000000-0000-7000-8000-00000000000a',
    accountId: '00000000-0000-7000-8000-00000000000b',
    today: '2026-10-07',
    showMoney: true,
    modules: new Set(['money', 'warranties', 'schedules']),
    currencies: new Set(['EGP', 'USD', 'SAR']),
    types: new Map([
      ['appliance', APPLIANCE],
      ['tool', TOOL],
    ]),
    typeInfo: new Map([
      [BOX, { builtin: true, caps: ['container'], fields: [] }],
      [APPLIANCE, { builtin: true, caps: ['warranty', 'serialized'], fields: [] }],
      [TOOL, { builtin: true, caps: ['warranty', 'serialized'], fields: [] }],
    ]),
    boxBinTypeId: BOX,
    tags: new Map(),
    brands: new Map(),
    vendors: new Map(),
    places: new Map(),
    unplacedId: UNPLACED,
    sourceIds: new Map(),
    takenCodes: new Set(),
    maxFileBytes: 25 * 1024 * 1024,
    ...over,
  };
}

const choices = (data: HomeboxData, over: Partial<HomeboxChoices> = {}): HomeboxChoices => ({
  archived: 'skip',
  currency: 'SAR',
  quantityRounding: 'keep_note',
  fields: {},
  // The web's default: a Kept type of the same name, else a new one (homebox-choices.tsx).
  types: Object.fromEntries(
    [...data.types.values()]
      .filter((t) => !t.is_location)
      .map((t) => [
        t.id,
        t.name === 'Appliance'
          ? { typeId: APPLIANCE }
          : t.name === 'Tool'
            ? { typeId: TOOL }
            : { create: t.name },
      ]),
  ),
  insured: 'field',
  seeded: 'skip_unused',
  ...over,
});

const things = (ops: HbOp[]) => ops.filter((o): o is ThingOp => o.op === 'thing');
const thing = (ops: HbOp[], name: string) => {
  const found = things(ops).find((t) => t.name === name);
  if (!found) throw new Error(`no thing ${name}`);
  return found;
};
const idOf = (data: HomeboxData, name: string) =>
  [...data.entities.values()].find((e) => e.name === name)?.id as string;
const issuesOf = (plan: ReturnType<typeof planHomebox>, id: string) =>
  plan.report.rows.find((r) => r.ref.id === id)?.issues.map((i) => i.code) ?? [];

beforeAll(async () => {
  files = await testFiles();
  home = await read('home');
  family = await read('family');
});

afterAll(async () => {
  await files?.cleanup();
});

describe('reading the fixtures', () => {
  it('parses every row of both exports, and never opens notifiers.json', () => {
    expect(home.bad).toEqual([]);
    expect(family.bad).toEqual([]);
    expect(home.entities.size).toBe(21);
    expect(family.entities.size).toBe(13);
    expect(home.ignored).toBe(1); // notifiers.json
    expect(home.manifest.groupId).toBe('1d93892c-082a-4fb4-9645-b78321688b99');
  });
});

describe('planHomebox over Home', () => {
  it('counts what the import would add', () => {
    const plan = planHomebox(home, choices(home), lookups());
    expect(plan.report.summary).toEqual({
      // Home, Kitchen, Study, Top shelf (the seeded eight are empty and skipped).
      places: 4,
      // Espresso machine, Fridge, Toolbox, Cordless drill, Bits tray, Wood screws, Desk lamp,
      // Kettle (Old phone is archived and skipped).
      things: 8,
      containers: 2,
      purchases: 2,
      warranties: 2,
      services: 1,
      schedules: 1,
      // Two photos, a manual, a warranty, a receipt and fridge.jpg; the .docx and .txt refused.
      attachments: 6,
      links: 1,
      // Tech, Audio, مطبخ, Fragile (the seeded six are unused and skipped).
      tags: 4,
      // Gadget isn't used (its one item is archived); Odd icon is new.
      types: 1,
      // Appliance: Colour, Boiler size (ml), Plumbed in, Insured, Voltage, Dishwasher safe (the
      // time fields are empty, Watts has no value).
      fieldsAdded: 6,
      // 12 entities (4 places, 8 things), each its asset ID and its UUID.
      legacyCodes: 24,
      skipped: 9,
      asText: 2,
      refusedFiles: 2,
    });
  });

  it('makes the item inside an item a container, and the location inside an item a box', () => {
    const plan = planHomebox(home, choices(home), lookups());
    const toolbox = thing(plan.ops, 'Toolbox');
    // Tool can't hold things: Toolbox is a box, with its Homebox type in the notes.
    expect(toolbox.type).toEqual({ id: BOX });
    expect(toolbox.notes).toContain('Homebox type: Tool');
    expect(thing(plan.ops, 'Cordless drill').where).toEqual({
      container: { key: idOf(home, 'Toolbox') },
    });
    const tray = thing(plan.ops, 'Bits tray');
    expect(tray.type).toEqual({ id: BOX });
    expect(issuesOf(plan, idOf(home, 'Bits tray'))).toContain('hb_location_in_item');
    expect(thing(plan.ops, 'Wood screws').where).toEqual({
      container: { key: idOf(home, 'Bits tray') },
    });
  });

  it('keeps a fractional quantity in the notes where the type counts one by one', () => {
    const plan = planHomebox(home, choices(home), lookups());
    const screws = thing(plan.ops, 'Wood screws');
    expect(screws.quantity).toBe(1);
    expect(screws.notes).toContain('Quantity in Homebox: 2.5');
    expect(issuesOf(plan, idOf(home, 'Wood screws'))).toContain('hb_quantity_rounded');
    // A type of its own (made here, not serialized) keeps 2.5.
    const own = planHomebox(home, choices(home, { types: {} }), lookups({ types: new Map() }));
    expect(thing(own.ops, 'Wood screws').quantity).toBe(2.5);
    // Quantity 0 from an API client became 1.
    expect(issuesOf(plan, idOf(home, 'Espresso machine'))).toContain('hb_quantity_zero');
  });

  it('maps the lifetime warranty, the dated one, the purchase and the sale', () => {
    const plan = planHomebox(home, choices(home, { archived: 'tag' }), lookups());
    const warranties = plan.ops.filter((o) => o.op === 'warranty');
    expect(warranties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thing: { key: idOf(home, 'Fridge') },
          body: { kind: 'manufacturer', startsOn: '2023-02-14', lifetime: true },
        }),
        expect.objectContaining({
          thing: { key: idOf(home, 'Espresso machine') },
          body: { kind: 'manufacturer', startsOn: '2024-11-03', endsOn: '2026-11-03' },
        }),
      ]),
    );
    const espresso = thing(plan.ops, 'Espresso machine');
    expect(espresso.purchase).toEqual({
      key: `${idOf(home, 'Espresso machine')}:purchase`,
      purchasedOn: '2024-11-03',
      price: '12999.99',
      currency: 'SAR',
      vendor: { create: 'Bean Bros' },
    });
    expect(espresso.brand).toEqual({ create: 'Rocket' });
    expect(espresso.notes).toBe(
      'Dual boiler\n\nDescale monthly.\nUse filtered water.\n\nWarranty: Two years, parts and labour',
    );
    const phone = thing(plan.ops, 'Old phone');
    expect(phone.sold).toEqual({
      endedOn: '2025-08-20',
      endedTo: 'Murdock',
      endedNotes: 'Paid in cash',
      endedPrice: '40',
      endedCurrency: 'SAR',
    });
    expect(phone.tags).toContainEqual({ key: 'tag:archived' });
    expect(plan.ops).toContainEqual(expect.objectContaining({ op: 'tag', key: 'tag:archived' }));
  });

  it('skips the archived item by default', () => {
    const plan = planHomebox(home, choices(home), lookups());
    expect(things(plan.ops).map((t) => t.name)).not.toContain('Old phone');
    expect(issuesOf(plan, idOf(home, 'Old phone'))).toEqual(['hb_archived_skipped']);
  });

  it('gives a child tag its parent too', () => {
    const plan = planHomebox(home, choices(home), lookups());
    const tech = [...home.tags.values()].find((t) => t.name === 'Tech')?.id;
    const audio = [...home.tags.values()].find((t) => t.name === 'Audio')?.id;
    expect(thing(plan.ops, 'Cordless drill').tags).toEqual([
      { key: `tag:${audio}` },
      { key: `tag:${tech}` },
    ]);
    // A named colour is read as its hex.
    const fragile = plan.ops.find(
      (o) => o.op === 'tag' && 'create' in o.target && o.target.create.name === 'Fragile',
    );
    expect(fragile).toMatchObject({ target: { create: { colour: '#FF0000' } } });
  });

  it('maps custom fields onto the type, a time field read as empty, numbers flagged as whole', () => {
    const plan = planHomebox(home, choices(home), lookups());
    const espresso = thing(plan.ops, 'Espresso machine');
    expect(espresso.custom).toEqual({
      colour: 'Brushed steel',
      boiler_size_ml: 1800,
      plumbed_in: true,
      insured: true,
    });
    const codes = issuesOf(plan, idOf(home, 'Espresso machine'));
    expect(codes).toContain('hb_time_default');
    expect(codes).toContain('hb_number_integer');
    const appliance = plan.ops.find(
      (o) =>
        o.op === 'type' &&
        o.key.endsWith([...home.types.values()].find((t) => t.name === 'Appliance')?.id as string),
    );
    // A built-in gaining fields is customised first.
    expect(appliance).toMatchObject({ customise: true, target: { id: APPLIANCE } });
    expect((appliance as { fields: { label: string; kind: string }[] }).fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Colour', kind: 'text' }),
        expect.objectContaining({ label: 'Insured', kind: 'boolean' }),
      ]),
    );
    // "Keep in notes" for one field.
    const noted = planHomebox(home, choices(home, { fields: { Colour: 'notes' } }), lookups());
    expect(thing(noted.ops, 'Espresso machine').notes).toContain('Colour: Brushed steel');
  });

  it('refuses the .docx and the text file by name, keeps the link, skips thumbnails', () => {
    const plan = planHomebox(home, choices(home), lookups());
    const refused = plan.report.rows.filter((r) =>
      r.issues.some((i) => i.code === 'file_type_refused'),
    );
    expect(refused.map((r) => r.ref.name).sort()).toEqual([
      'espresso-notes.txt',
      'espresso-quickstart.docx',
    ]);
    const attachments = plan.ops.filter((o) => o.op === 'attachment');
    expect(attachments.some((a) => a.op === 'attachment' && a.title.endsWith('-thumb'))).toBe(
      false,
    );
    expect(attachments).toContainEqual(
      expect.objectContaining({
        url: 'https://example.com/manuals/r58?lang=en#setup',
        role: 'manual',
        file: null,
      }),
    );
    // The primary photo first; the warranty PDF on the warranty, the receipt on the purchase.
    const front = attachments.find(
      (a) => a.op === 'attachment' && a.title === 'espresso-front.jpg',
    );
    expect(front).toMatchObject({ sort: 0, role: 'photo' });
    expect(
      attachments.find((a) => a.op === 'attachment' && a.title === 'espresso-warranty.pdf'),
    ).toMatchObject({ subject: 'warranty', role: 'warranty_doc' });
    expect(
      attachments.find((a) => a.op === 'attachment' && a.title === 'espresso-receipt.jpg'),
    ).toMatchObject({ subject: 'purchase', role: 'receipt' });
  });

  it('keeps money as text where money is off, and records as text where their module is off', () => {
    const plan = planHomebox(
      home,
      choices(home),
      lookups({ showMoney: false, modules: new Set(['money']) }),
    );
    const espresso = thing(plan.ops, 'Espresso machine');
    expect(espresso.purchase).toBeNull();
    expect(espresso.notes).toContain('Price: 12999.99 SAR');
    expect(espresso.notes).toContain('Warranty until: 2026-11-03');
    expect(espresso.notes).toContain('Maintenance: Descale');
    const codes = issuesOf(plan, idOf(home, 'Espresso machine'));
    expect(codes).toContain('money_off');
    expect(codes).toContain('hb_needs_module');
    expect(plan.ops.filter((o) => o.op === 'warranty' || o.op === 'service')).toEqual([]);
  });

  it('marks a code the location already has as taken, and skips what an earlier run made', () => {
    const espresso = idOf(home, 'Espresso machine');
    const plan = planHomebox(
      home,
      choices(home),
      lookups({ takenCodes: new Set(['000-005']), sourceIds: new Map([[espresso, newId()]]) }),
    );
    expect(things(plan.ops).map((t) => t.key)).not.toContain(espresso);
    expect(issuesOf(plan, espresso)).toContain('already_imported');
    const again = planHomebox(home, choices(home), lookups({ takenCodes: new Set(['000-005']) }));
    expect(thing(again.ops, 'Espresso machine').codes).toEqual([espresso.toUpperCase()]);
    expect(issuesOf(again, espresso)).toContain('code_taken');
  });

  it('reports a malformed row and plans the rest', () => {
    const broken: HomeboxData = {
      ...home,
      bad: [{ table: 'entities', index: 3, id: 'x', name: 'Broken' }],
    };
    const plan = planHomebox(broken, choices(broken), lookups());
    expect(plan.report.rows.find((r) => r.ref.id === 'x')?.issues[0]?.code).toBe('entry_ignored');
    expect(plan.report.summary.things).toBe(8);
  });

  it('notes the notifier without reading it', () => {
    const plan = planHomebox(home, choices(home), lookups());
    expect(plan.report.rows.find((r) => r.ref.id === 'notifiers.json')?.issues[0]?.code).toBe(
      'hb_notifier_skipped',
    );
  });
});

describe('planHomebox over بيت العائلة', () => {
  it('gives its 000-005 its own code and a container for the remote inside the TV', () => {
    const plan = planHomebox(family, choices(family), lookups());
    const tv = thing(plan.ops, 'تلفزيون سامسونج');
    const remote = thing(plan.ops, 'ريموت');
    expect(remote.where).toEqual({ container: { key: tv.key } });
    expect(remote.codes).toContain('000-005');
    expect(tv.serial).toBe('٠١٢٣٤٥');
    expect(plan.report.summary).toMatchObject({ things: 3, places: 2, containers: 1, services: 1 });
  });
});
