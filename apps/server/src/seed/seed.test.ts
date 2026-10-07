import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { asOwner } from '../../test/tenancy.js';
import type { Env } from '../config/env.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { HOUSEHOLDS, SEED_PASSWORD } from './cast.js';
import { formatSeedReport, type SeedReport } from './households.js';
import { assertSeedAllowed, buildSeedApp, runSeed, SeedRefused } from './index.js';

// Tasks 26 and 23 (D152, D185): the households scenario with its inventory, through the service
// layer, idempotent; and the bench scenario at a small size (the 10k run is task 24's).

const env = {
  KEPT_PUBLIC_URL: 'http://localhost:5173',
  KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
} as Pick<Env, 'KEPT_PUBLIC_URL' | 'KEPT_AUTH_SECRET'>;

const TABLES = [
  'auth."user"',
  'auth.account',
  'public.locations',
  'public.memberships',
  'public.invites',
  'public.user_profiles',
  'public.audit_events',
  'public.instance_admins',
  'public.places',
  'public.things',
  'public.thing_tags',
  'public.thing_links',
  'public.short_ids',
  'public.brands',
  'public.vendors',
  'public.people',
  'public.tags',
  'public.types',
  'public.type_fields',
  'public.purchases',
  'public.purchase_lines',
  'public.meters',
  'public.meter_readings',
  'public.files',
  'public.file_derivatives',
  'public.attachments',
  'public.saved_views',
  'public.location_modules',
];

/** The keyring the secret-value routes need (task 19). */
const secretKeys = fixedSecretKeys(
  keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }),
);

let db: TestDb;
let files: TestFiles;
let first: SeedReport;
let second: SeedReport;
let countsAfterFirst: Record<string, number>;

const counts = () =>
  asOwner(db, async (c) => {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
      out[table] = rows[0].n;
    }
    return out;
  });

/** GET as a seeded person, signed in through the real route. */
async function asPerson(email: string, url: string): Promise<Record<string, unknown>> {
  const app = await buildSeedApp(env, db.pools as never, files);
  try {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { origin: env.KEPT_PUBLIC_URL },
      remoteAddress: '203.0.113.20',
      payload: { email, password: SEED_PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const raw = signIn.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)])
      .map((l) => l.split(';')[0])
      .join('; ');
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  } finally {
    await app.close();
  }
}

const searchNames = async (email: string, q: string) => {
  const body = (await asPerson(
    email,
    `/api/v1/search?${new URLSearchParams({ q, kind: 'things', limit: '50' })}`,
  )) as { things: { items: { name: string }[] } };
  return body.things.items.map((t) => t.name);
};

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  first = await runSeed('households', env, db.pools as never, { files, app: { secretKeys } });
  countsAfterFirst = await counts();
  second = await runSeed('households', env, db.pools as never, {
    files,
    app: { secretKeys },
  });
}, 240_000);

afterAll(async () => {
  await files?.cleanup();
});

describe('kept admin seed --scenario households', () => {
  it('refuses to run in production', () => {
    expect(() => assertSeedAllowed('production')).toThrow(SeedRefused);
    expect(() => assertSeedAllowed('development')).not.toThrow();
    expect(() => assertSeedAllowed(undefined)).not.toThrow();
  });

  it('makes the households with every role, a managed child and an ending membership', async () => {
    expect(first.created).toBeGreaterThan(0);
    expect(first.households.map((h) => h.name)).toEqual(HOUSEHOLDS.map((h) => h.name));
    const rows = await asOwner(db, async (c) => {
      const { rows } = await c.query<{
        location: string;
        kind: string;
        currency: string;
        languages: string[];
        name: string;
        role: string;
        managed: boolean;
        ends: boolean;
      }>(
        `SELECT l.name AS location, l.kind, l.currency, l.languages, p.display_name AS name, m.role,
                coalesce(p.managed, false) AS managed, m.expires_at IS NOT NULL AS ends
           FROM public.memberships m
           JOIN public.locations l ON l.id = m.location_id
           JOIN public.user_profiles p ON p.user_id = m.user_id
          WHERE l.kind <> 'personal'
          ORDER BY l.name, m.role, p.display_name`,
      );
      return rows;
    });
    const home = rows.filter((r) => r.location === 'Home');
    expect(home.map((r) => [r.name, r.role, r.managed, r.ends])).toEqual([
      ['Bruce', 'admin', false, false],
      ['Alfred', 'member', false, false],
      ['Louis', 'member', false, true],
      ['Peter', 'member', true, false],
      ['Ibrahim', 'owner', false, false],
      ['Talia', 'viewer', false, false],
    ]);
    const garage = rows.filter((r) => r.location === 'Garage');
    expect(garage.map((r) => [r.name, r.role])).toEqual([
      ['Bruce', 'admin'],
      ['Alfred', 'member'],
      ['Ibrahim', 'owner'],
    ]);
    expect(garage[0]?.kind).toBe('garage');
    const arabic = rows.filter((r) => r.location === 'بيت العائلة');
    expect(arabic.map((r) => [r.name, r.role])).toEqual([
      ['Ibrahim', 'admin'],
      ['Bruce', 'member'],
      ['Alfred', 'owner'],
    ]);
    expect(arabic[0]).toMatchObject({ currency: 'EGP', languages: ['ar-EG'] });
    expect(home[0]).toMatchObject({ currency: 'EGP', languages: ['en'] });
  });

  it('made everything the way a person would: audited, with profiles in their language', async () => {
    const { actions, alfred, admins } = await asOwner(db, async (c) => ({
      actions: (
        await c.query<{ action: string }>(
          'SELECT DISTINCT action FROM public.audit_events ORDER BY action',
        )
      ).rows.map((r) => r.action),
      alfred: (
        await c.query<{ locale: string }>(
          `SELECT p.locale FROM public.user_profiles p JOIN auth."user" u ON u.id = p.user_id
            WHERE u.email = 'alfred@kept.test'`,
        )
      ).rows[0]?.locale,
      admins: (
        await c.query<{ email: string }>(
          'SELECT u.email FROM public.instance_admins a JOIN auth."user" u ON u.id = a.user_id',
        )
      ).rows.map((r) => r.email),
    }));
    expect(actions).toEqual(
      expect.arrayContaining([
        'instance.setup',
        'invite.create',
        'member.join',
        'place.create',
        'place.label',
        'thing.create',
        'thing.label',
        'purchase.create',
        'reading.create',
        'secret.set',
        'instance.recovery_kit_acknowledge',
      ]),
    );
    expect(alfred).toBe('ar-EG');
    expect(admins).toEqual(['ibrahim@kept.test']);
  });

  it('fills the households with places, things, purchases, readings, photos and views', async () => {
    const perLocation = await asOwner(db, async (c) => {
      const { rows } = await c.query<{ name: string; places: number; things: number }>(
        `SELECT l.name,
                (SELECT count(*)::int FROM public.places p
                  WHERE p.location_id = l.id AND NOT p.is_unplaced) AS places,
                (SELECT count(*)::int FROM public.things t WHERE t.location_id = l.id) AS things
           FROM public.locations l WHERE l.kind <> 'personal' ORDER BY l.name`,
      );
      return Object.fromEntries(rows.map((r) => [r.name, [r.places, r.things]]));
    });
    expect(perLocation.Home?.[0]).toBeGreaterThanOrEqual(14);
    expect(perLocation.Home?.[1]).toBeGreaterThanOrEqual(35);
    expect(perLocation.Garage).toEqual([5, 12]);
    // With records.ts's Hyundai and generator (step-5 T16).
    expect(perLocation['بيت العائلة']).toEqual([6, 13]);
    const total = Object.values(perLocation).reduce((n, [, t]) => n + (t ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(58);

    const facts = await asOwner(db, async (c) => {
      const all = async (sql: string) => (await c.query(sql)).rows;
      return {
        codes: await all(
          `SELECT s.code, coalesce(t.name, p.name) AS name FROM public.short_ids s
             LEFT JOIN public.things t ON t.id = s.thing_id
             LEFT JOIN public.places p ON p.id = s.place_id WHERE s.is_primary ORDER BY s.code`,
        ),
        hdmi: (
          await all(
            `SELECT t.place_path, c.name AS container FROM public.things t
               JOIN public.things c ON c.id = t.container_id WHERE t.name = 'HDMI cable, 2 m'`,
          )
        )[0],
        corolla: await all(
          `SELECT r.value::text, r.state FROM public.meter_readings r
             JOIN public.meters m ON m.id = r.meter_id
             JOIN public.things t ON t.id = m.thing_id
            WHERE t.name = 'Toyota Corolla' AND r.source <> 'fuel'
              -- stock.ts's readings; records.ts adds the fills' and the services' own.
              AND NOT EXISTS (SELECT 1 FROM public.service_records s WHERE s.meter_reading_id = r.id)
            ORDER BY r.taken_at`,
        ),
        lines: await all(
          `SELECT l.description, t.name FROM public.purchase_lines l
             JOIN public.things t ON t.purchase_line_id = l.id
             JOIN public.purchases p ON p.id = l.purchase_id
            WHERE p.notes = 'Paid in 12 instalments.' ORDER BY l.description`,
        ),
        receipts: (
          await all(
            `SELECT count(*)::int AS n FROM public.attachments a
               JOIN public.files f ON f.id = a.file_id
              WHERE a.role = 'receipt' AND f.class = 'evidence'`,
          )
        )[0]?.n,
        photos: (
          await all(
            `SELECT count(*)::int AS n FROM public.attachments a
               JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
              WHERE a.role = 'photo' AND a.thing_id IS NOT NULL`,
          )
        )[0]?.n,
        views: (await all('SELECT name FROM public.saved_views ORDER BY name')).map((r) => r.name),
        custom: (await all(`SELECT custom FROM public.things WHERE name = 'Catan'`))[0]?.custom,
        kettle: (
          await all(`SELECT lifecycle, ended_to FROM public.things WHERE name = 'Old kettle'`)
        )[0],
        uncertain: (
          await all('SELECT name FROM public.things WHERE location_uncertain ORDER BY name')
        ).map((r) => r.name),
        secretValues: (
          await all(
            `SELECT t.name, v.field_key FROM public.secret_values v
               JOIN public.things t ON t.id = v.thing_id ORDER BY t.name`,
          )
        ).map((r) => `${r.name}: ${r.field_key}`),
        kit: (
          await all(
            `SELECT count(*)::int AS n FROM public.instance_settings
              WHERE key = 'recovery_kit_acknowledged_at'`,
          )
        )[0]?.n,
        secrets: await all(
          `SELECT l.name FROM public.location_modules m JOIN public.locations l ON l.id = m.location_id
            WHERE m.enabled AND m.module = 'secrets'`,
        ),
      };
    });
    expect(facts.codes).toEqual(
      expect.arrayContaining([
        { code: '3CB8WN', name: 'Cable box' },
        { code: '7KQ4MZ', name: 'HDMI cable, 2 m' },
        { code: '4VC7HD', name: 'Toyota Corolla' },
        { code: '5MT0QD', name: 'Samsung TV, 55″' },
        { code: '9RT2FK', name: 'Wi-Fi router' },
        { code: '7SH2AA', name: 'Shelf A' },
      ]),
    );
    expect(facts.hdmi).toMatchObject({ container: 'Cable box' });
    expect(String(facts.hdmi?.place_path)).toContain('Desk drawer');
    expect(facts.corolla).toEqual([
      { value: '51200.000', state: 'accepted' },
      { value: '52340.000', state: 'accepted' },
      { value: '523400.000', state: 'needs_review' },
    ]);
    expect(facts.lines).toEqual([
      { description: 'HDMI cable 2 m', name: 'HDMI cable, 2 m' },
      { description: 'Samsung 55" QLED Q60B', name: 'Samsung TV, 55″' },
    ]);
    expect(facts.receipts).toBe(2);
    expect(facts.photos).toBe(7);
    expect(facts.views).toEqual(['Cables', 'Needs a look', "Peter's things", 'الأدوات']);
    expect(facts.custom).toEqual({ players: '3–4', complete: true });
    expect(facts.kettle).toEqual({ lifecycle: 'given_away', ended_to: 'Alfred' });
    expect(facts.uncertain).toEqual(['Christmas lights', 'HDMI cable, 5 m']);
    expect(facts.secrets).toEqual([{ name: 'Home' }]);
    expect(facts.kit).toBe(1);
    expect(facts.secretValues).toEqual(['Wall safe: combination', 'Wi-Fi router: wifi_password']);
    expect(first.notes).toEqual([]);
  });

  it("keeps step 4's records and step 5's vehicles: warranties to fills (records.ts)", async () => {
    const n = await asOwner(db, async (c) => {
      const one = async (sql: string) => Number((await c.query(sql)).rows[0]?.n ?? 0);
      const corolla = `(SELECT id FROM public.things WHERE name = 'Toyota Corolla')`;
      const hyundai = `(SELECT id FROM public.things WHERE name = 'هيونداي إلنترا')`;
      return {
        warranties: await one('SELECT count(*) AS n FROM public.warranties'),
        claims: await one(`SELECT count(*) AS n FROM public.claims WHERE status = 'in_repair'`),
        valuations: await one('SELECT count(*) AS n FROM public.valuations'),
        openLoans: await one('SELECT count(*) AS n FROM public.loans WHERE returned_at IS NULL'),
        schedules: await one('SELECT count(*) AS n FROM public.schedules'),
        documents: await one('SELECT count(*) AS n FROM public.expiring_documents'),
        incidents: await one('SELECT count(*) AS n FROM public.incidents'),
        rates: await one('SELECT count(*) AS n FROM public.fx_rates'),
        corollaFills: await one(
          `SELECT count(*) AS n FROM public.fuel_entries WHERE thing_id = ${corolla}`,
        ),
        partials: await one(
          `SELECT count(*) AS n FROM public.fuel_entries WHERE thing_id = ${corolla} AND NOT is_full`,
        ),
        missed: await one(
          `SELECT count(*) AS n FROM public.fuel_entries WHERE thing_id = ${corolla} AND missed_before`,
        ),
        hyundaiFills: await one(
          `SELECT count(*) AS n FROM public.fuel_entries WHERE thing_id = ${hyundai}`,
        ),
        services: await one(
          `SELECT count(*) AS n FROM public.service_records
            WHERE thing_id = ${corolla} AND review_state = 'confirmed'`,
        ),
        oilDone: await one(
          `SELECT count(*) AS n FROM public.service_completions c
             JOIN public.schedules s ON s.id = c.schedule_id
            WHERE s.thing_id = ${corolla} AND s.name = 'Oil change'`,
        ),
        proofs: await one(`SELECT count(*) AS n FROM public.attachments WHERE role = 'proof'`),
        typo: await one(
          `SELECT count(*) AS n FROM public.meter_readings
            WHERE value = 523400 AND state = 'needs_review'`,
        ),
        generatorReadings: await one(
          `SELECT count(*) AS n FROM public.meter_readings d JOIN public.meters m ON m.id = d.meter_id
            WHERE m.kind = 'hours'`,
        ),
      };
    });
    expect(n).toEqual({
      warranties: 5,
      claims: 1,
      valuations: 3,
      openLoans: 2,
      schedules: 8,
      documents: 5,
      incidents: 1,
      rates: 2,
      corollaFills: 20,
      partials: 1,
      missed: 1,
      hyundaiFills: 10,
      services: 2,
      oilDone: 1,
      proofs: 2,
      typo: 1,
      generatorReadings: 2,
    });
    // The Corolla's consumption: 7.3 L/100 km over its last five full-to-full intervals.
    const [corolla] = await asOwner(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.things WHERE name = 'Toyota Corolla'`,
      );
      return rows;
    });
    const summary = (await asPerson(
      'ibrahim@kept.test',
      `/api/v1/things/${corolla?.id}/fuel/summary`,
    )) as { byUnit: { unit: string; consumption: { perHundred: string } | null }[] };
    const litres = summary.byUnit.find((u) => u.unit === 'L');
    expect(Number(litres?.consumption?.perHundred)).toBeCloseTo(7.3, 1);
  });

  it('is a no-op the second time', async () => {
    expect(second.created).toBe(0);
    expect(await counts()).toEqual(countsAfterFirst);
    expect(second.accounts).toEqual(first.accounts);
    expect(second.households).toEqual(first.households);
    expect(second.inventory).toEqual(first.inventory);
  });

  it('finds "hdmi" in what it made, across the locations a person belongs to', async () => {
    const ibrahim = await searchNames('ibrahim@kept.test', 'hdmi');
    expect(ibrahim).toEqual(
      expect.arrayContaining([
        'HDMI cable, 2 m',
        'HDMI cable, 5 m',
        'Display cable, 1.8 m',
        'كابل HDMI',
      ]),
    );
    // Talia is a viewer of Home only.
    const talia = await searchNames('talia@kept.test', 'hdmi');
    expect(talia).toContain('HDMI cable, 2 m');
    expect(talia).not.toContain('كابل HDMI');
    expect(talia).not.toContain('HDMI cable, 5 m');
  });

  it("searches the Arabic household's names without harakat, alef forms or ال", async () => {
    expect(await searchNames('alfred@kept.test', 'مكواه')).toContain('مِكْواة البُخار');
    expect(await searchNames('alfred@kept.test', 'مفك')).toContain('مِفَكّ براغي');
    expect(await searchNames('alfred@kept.test', 'مكتبه')).toContain('المكتبة');
    expect(await searchNames('alfred@kept.test', 'فانوس')).toContain('فَانُوس رَمَضَان');
  });

  it('prints sign-in details that work, the managed child by username', async () => {
    const text = formatSeedReport(second, env.KEPT_PUBLIC_URL);
    expect(text).toContain('already seeded, nothing to do');
    expect(text).toContain(`Every password is: ${SEED_PASSWORD}`);
    expect(text).toContain('ibrahim@kept.test');
    expect(text).toContain('peter (username)');
    expect(text).toMatch(/Ibrahim\s+ibrahim@kept\.test\s+instance admin · Home: owner/);
    expect(text).toMatch(/Louis\s+louis@kept\.test\s+Home: member until \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/Garage: 5 places, 12 things/);

    const app = await buildSeedApp(env, db.pools as never);
    try {
      for (const account of first.accounts) {
        const res = await app.inject({
          method: 'POST',
          url: account.managed ? '/api/v1/auth/sign-in/username' : '/api/v1/auth/sign-in/email',
          headers: { origin: env.KEPT_PUBLIC_URL },
          remoteAddress: '203.0.113.9',
          payload: account.managed
            ? { username: account.login, password: account.password }
            : { email: account.login, password: account.password },
        });
        expect(res.statusCode, account.login).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});

describe('kept admin seed --scenario bench', () => {
  let bench: SeedReport;
  let again: SeedReport;

  beforeAll(async () => {
    await db.reset();
    bench = await runSeed('bench', env, db.pools as never, {
      bench: { things: 400, ownerUrl: db.urls.owner },
    });
    again = await runSeed('bench', env, db.pools as never, {
      bench: { things: 400, ownerUrl: db.urls.owner },
    });
  }, 240_000);

  it('makes three locations of 400, 80 and 20 things, with containers, places and photos', async () => {
    const info = bench.bench;
    expect(info?.locations.map((l) => [l.name, l.things, l.containers])).toEqual([
      ['Bench 10k', 400, 200],
      ['Bench 2k', 80, 70],
      ['Bench 500', 20, 30],
    ]);
    expect(info?.locations.map((l) => l.places)).toEqual([206, 68, 20]);
    expect(info?.showcaseThingIds).toHaveLength(10);
    const facts = await asOwner(db, async (c) => ({
      room: (
        await c.query('SELECT count(*)::int AS n FROM public.things WHERE place_id = $1', [
          info?.bigRoomId,
        ])
      ).rows[0].n,
      arabic: (
        await c.query(
          `SELECT count(*)::int AS n FROM public.things WHERE serial LIKE 'BN%' AND name ~ '[ء-ي]'`,
        )
      ).rows[0].n,
      tagged: (await c.query('SELECT count(*)::int AS n FROM public.thing_tags')).rows[0].n,
      unindexed: (
        await c.query(
          `SELECT count(*)::int AS n FROM public.things
            WHERE serial LIKE 'BN%' AND search_tsv IS NULL`,
        )
      ).rows[0].n,
      members: (
        await c.query(
          `SELECT m.role, count(*)::int AS n FROM public.memberships m
             JOIN public.locations l ON l.id = m.location_id
            WHERE l.name LIKE 'Bench%' GROUP BY m.role ORDER BY m.role`,
        )
      ).rows,
    }));
    expect(facts.room).toBe(200);
    expect(facts.arabic / 500).toBeGreaterThan(0.2);
    expect(facts.arabic / 500).toBeLessThan(0.4);
    expect(facts.tagged).toBe(250);
    expect(facts.unindexed).toBe(0);
    expect(facts.members).toEqual([
      { role: 'member', n: 3 },
      { role: 'owner', n: 3 },
      { role: 'viewer', n: 3 },
    ]);
    expect(info?.locations.every((l) => l.photos > 0)).toBe(true);
  });

  it('is a no-op the second time', () => {
    expect(bench.created).toBeGreaterThan(0);
    expect(again.created).toBe(0);
    expect(again.bench?.locations).toEqual(bench.bench?.locations);
  });

  it('is found by search as the viewer, through row-level security', async () => {
    expect((await searchNames('bench-viewer@kept.test', 'cable')).length).toBeGreaterThan(0);
  });
});
