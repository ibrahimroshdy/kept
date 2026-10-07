import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import pg from 'pg';
import { withScope } from '../db/scope.js';
import type { Cast, Person } from './cast.js';
import { expectStatus, type Json, SeedError } from './client.js';
import { emptyReport, type SeedContext, type SeedReport, seedCast } from './households.js';
import { BENCH_BRANDS, BENCH_TAGS, pick, prng, ROOM_NAMES, thingName } from './words.js';

// `kept admin seed --scenario bench [--things N]` (task 23): the load fixture for task 24's RLS
// benchmark (risk #3). Three locations of one owner, with a member and a viewer in each:
//
// | location  | things | containers | places (4 levels in the first) | photo attachments |
// | Bench 10k | N      | 200        | ~205, plus "Storage room"      | 1,600             |
// | Bench 2k  | N / 5  | 70         | ~68                            | 300               |
// | Bench 500 | N / 20 | 30         | ~20                            | 100               |
//
// "Storage room" in Bench 10k holds exactly 200 things directly: the benchmark's place-contents
// page. 30% of the names are Arabic (words.ts), half the things carry a tag, a third a brand, and
// every one a serial (`BN<location>-<n>`, which is also how a second run finds where it stopped).
// Ten showcase things in Bench 10k (five cars with a purchase, readings and a photo, five
// chargers linked to them) are the benchmark's thing page.
//
// How it is made, and why (plan T23; the step's rule: never bypass RLS):
// - Accounts, locations, memberships, registries, places and the showcase things go through the
//   real routes, like the households scenario.
// - The bulk (containers, things, tags, file rows and attachments) is inserted in batches of 1,000
//   by plain INSERTs on kept_app inside withScope() as the owner: every row passes the same
//   row-level-security policies, column grants, foreign keys and triggers (search_tsv, place_path,
//   touch_row, stamp_request_user) as a request's. It skips the per-thing audit events and the
//   service's validation: this is a load fixture, and 12,500 audited requests would take minutes.
//   File rows carry no blobs (thumbnail derivative rows only): nothing serves their bytes.
// - `ANALYZE` needs the tables' owner: with `ownerUrl` it runs as kept_owner (statistics only,
//   no rows read or written); without, autovacuum's analyse catches up and the report says so.
//
// Idempotent: people, locations, registries and places are found by name; the bulk counts the
// rows it made (by serial) and adds only the missing tail, and the PRNG is seeded per location,
// so a second run is a no-op and an interrupted one resumes.

export type BenchOptions = {
  /** Things in the largest location (default 10,000); the others get a fifth and a twentieth. */
  things?: number;
  /** A progress line per batch (the CLI prints them to stderr). */
  onProgress?: (line: string) => void;
  /** kept_owner's URL, for ANALYZE at the end. */
  ownerUrl?: string;
};

export type BenchLocation = {
  name: string;
  id: string;
  things: number;
  containers: number;
  places: number;
  photos: number;
};

export type BenchInfo = {
  locations: BenchLocation[];
  /** The benchmark's three actors (T24). */
  actors: Record<'owner' | 'member' | 'viewer', { login: string; userId: string }>;
  /** Bench 10k's "Storage room": 200 things directly in it. */
  bigRoomId: string;
  /** The showcase things (purchase, meter readings, photo, link). */
  showcaseThingIds: string[];
  seconds: number;
};

type BenchKey = 'benchOwner' | 'benchMember' | 'benchViewer';

const person = (email: string, displayName: string): Person => ({
  email,
  displayName,
  locale: 'en',
  timezone: 'Africa/Cairo',
});

export const BENCH_CAST: Cast<BenchKey> = {
  people: {
    benchOwner: person('bench-owner@kept.test', 'Bench owner'),
    benchMember: person('bench-member@kept.test', 'Bench member'),
    benchViewer: person('bench-viewer@kept.test', 'Bench viewer'),
  },
  instanceAdmin: 'benchOwner',
  managed: {},
  households: ['Bench 10k', 'Bench 2k', 'Bench 500'].map((name) => ({
    name,
    kind: 'home' as const,
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    languages: ['en', 'ar-EG'],
    owner: 'benchOwner' as const,
    members: [
      { who: 'benchMember' as const, role: 'member' as const },
      { who: 'benchViewer' as const, role: 'viewer' as const },
    ],
    managed: [],
  })),
};

/** Built-in types the bulk draws from (quantity 1 fits every one); null is untyped. */
const THING_TYPES = [
  'cable',
  'charger',
  'tool',
  'power_tool',
  'furniture',
  'small_appliance',
  'electronics',
  'tv_display',
  'camera',
  'console',
  'batteries',
  'consumables',
  'collectible',
  null,
  null,
] as const;

const BATCH = 1000;
const BIG_ROOM = 'Storage room';

type PlaceDef = { name: string; kind: 'room' | 'zone' | 'closet'; children?: PlaceDef[] };

/** The place tree of a location: `depth` levels under `rooms` rooms. */
function placeTree(rooms: number, fanout: readonly number[]): PlaceDef[] {
  const level = (depth: number, prefix: string): PlaceDef[] => {
    const count = fanout[depth] ?? 0;
    const names = ['Zone', 'Shelf', 'Bin'];
    return Array.from({ length: count }, (_, i) => {
      const name = `${names[depth] ?? 'Part'} ${prefix}${i + 1}`;
      const children = level(depth + 1, `${prefix}${i + 1}.`);
      return {
        name,
        kind: depth === 0 ? ('closet' as const) : ('zone' as const),
        ...(children.length ? { children } : {}),
      };
    });
  };
  return Array.from({ length: rooms }, (_, r) => {
    const children = level(0, `${r + 1}.`);
    return {
      name: ROOM_NAMES[r] ?? `Room ${r + 1}`,
      kind: 'room' as const,
      ...(children.length ? { children } : {}),
    };
  });
}

export async function seedBench(ctx: SeedContext, opts: BenchOptions): Promise<SeedReport> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const big = opts.things ?? 10_000;
  if (!Number.isInteger(big) || big < 200 || big > 1_000_000) {
    throw new SeedError('--things must be a whole number from 200 to 1,000,000');
  }
  const report = emptyReport('bench');
  const session = await seedCast(ctx, BENCH_CAST, report);
  const { client } = session;
  const made = () => {
    report.created += 1;
  };
  const owner = session.cookieOf('benchOwner');
  const get = async (url: string, what: string, cookie = owner) =>
    expectStatus(await client.call('GET', url, { cookie }), [200], what);
  const post = async (url: string, body: unknown, what: string, headers?: Record<string, string>) =>
    expectStatus(await client.call('POST', url, { cookie: owner, body, headers }), [201], what);

  const userIdOf = async (key: BenchKey) =>
    String(((await get('/api/v1/me', 'me', session.cookieOf(key))).user as Json).id);
  const ownerId = await userIdOf('benchOwner');

  // --- registries: types (built-in), brands, tags ------------------------------------------------
  const accountId = (
    (await get('/api/v1/accounts', 'accounts')) as { accounts: { id: string; isOwn: boolean }[] }
  ).accounts.find((a) => a.isOwn)?.id;
  if (!accountId) throw new SeedError('the bench owner has no account');
  const types = new Map<string, string>();
  for (const t of (
    (await get(`/api/v1/accounts/${accountId}/types`, 'types')) as {
      types: { id: string; builtinKey: string | null }[];
    }
  ).types) {
    if (t.builtinKey && !types.has(t.builtinKey)) types.set(t.builtinKey, t.id);
  }
  const typeId = (key: string) => {
    const id = types.get(key);
    if (!id) throw new SeedError(`no built-in type ${key}`);
    return id;
  };
  const registry = async (kind: 'brands' | 'tags', names: readonly string[]) => {
    const page = (await get(`/api/v1/accounts/${accountId}/${kind}?limit=200`, kind)) as {
      items: { id: string; name: string }[];
    };
    const ids = new Map(page.items.map((i) => [i.name, i.id]));
    for (const name of names) {
      if (ids.has(name)) continue;
      const res = await post(`/api/v1/accounts/${accountId}/${kind}`, { name }, `${kind} ${name}`);
      ids.set(name, String((res.item as Json).id));
      made();
    }
    return names.map((n) => ids.get(n) as string);
  };
  const brandIds = await registry('brands', BENCH_BRANDS);
  const tagIds = await registry('tags', BENCH_TAGS);

  // --- per location ------------------------------------------------------------------------------
  const sizes = [
    { things: big, containers: 200, photos: 1600, rooms: 5, fanout: [4, 3, 2] },
    {
      things: Math.round(big / 5),
      containers: 70,
      photos: 300,
      rooms: 4,
      fanout: [4, 3],
    },
    { things: Math.round(big / 20), containers: 30, photos: 100, rooms: 4, fanout: [4] },
  ];
  const locations: BenchLocation[] = [];
  let bigRoomId = '';
  const showcaseThingIds: string[] = [];

  for (const [index, household] of BENCH_CAST.households.entries()) {
    const size = sizes[index];
    const locationId = report.households.find((h) => h.name === household.name)?.id;
    if (!size || !locationId) throw new SeedError(`no location ${household.name}`);
    const n = index + 1;

    // Places, through the route, parents first.
    const nodes = (
      (await get(`/api/v1/locations/${locationId}/places`, 'places')) as {
        places: { id: string; parentId: string | null; name: string; isUnplaced: boolean }[];
      }
    ).places;
    const unplacedId = nodes.find((p) => p.isUnplaced)?.id as string;
    const placeIds: string[] = [];
    const ensurePlace = async (def: PlaceDef, parentId: string | null): Promise<string> => {
      let id = nodes.find(
        (p) => !p.isUnplaced && p.name === def.name && p.parentId === parentId,
      )?.id;
      if (!id) {
        id = String(
          (
            await post(
              `/api/v1/locations/${locationId}/places`,
              { parentId, name: def.name, kindKey: def.kind },
              `place ${def.name}`,
            )
          ).id,
        );
        made();
      }
      return id;
    };
    const walk = async (defs: readonly PlaceDef[], parentId: string | null) => {
      for (const def of defs) {
        const id = await ensurePlace(def, parentId);
        placeIds.push(id);
        if (def.children) await walk(def.children, id);
      }
    };
    await walk(placeTree(size.rooms, size.fanout), null);
    let roomId: string | null = null;
    if (index === 0) {
      roomId = await ensurePlace({ name: BIG_ROOM, kind: 'room' }, null);
      bigRoomId = roomId;
    }
    progress(`${household.name}: ${placeIds.length + (roomId ? 1 : 0)} places`);

    // The bulk, as the owner on kept_app (see the header).
    const scope = { userId: ownerId, mfa: false };
    const counted = await withScope(ctx.pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{ things: number; boxes: number }>(
        `SELECT count(*) FILTER (WHERE serial LIKE $2)::int AS things,
                count(*) FILTER (WHERE serial LIKE $3)::int AS boxes
           FROM public.things WHERE location_id = $1`,
        [locationId, `BN${n}-%`, `BX${n}-%`],
      );
      return rows[0] ?? { things: 0, boxes: 0 };
    });

    // Containers: deterministic per index, in random places.
    const containerIds: string[] = [];
    const boxRand = prng(n * 7919);
    const boxRows: { id: string; place: string; name: string; serial: string }[] = [];
    for (let i = 0; i < size.containers; i++) {
      const place = pick(boxRand, placeIds);
      boxRows.push({ id: newId(), place, name: `Box ${i + 1}`, serial: `BX${n}-${pad(i)}` });
    }
    if (counted.boxes < size.containers) {
      const todo = boxRows.slice(counted.boxes);
      await withScope(ctx.pools.app, scope, (_tx, c) =>
        c.query(
          `INSERT INTO public.things (id, location_id, place_id, type_id, name, serial, created_via)
           SELECT id, $1, place, $2, name, serial, 'import'
             FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[]) AS r(id, place, name, serial)`,
          [
            locationId,
            typeId('box_bin'),
            todo.map((r) => r.id),
            todo.map((r) => r.place),
            todo.map((r) => r.name),
            todo.map((r) => r.serial),
          ],
        ),
      );
      report.created += todo.length;
    }
    // The containers' real ids (a resumed run made some before).
    const boxes = await withScope(ctx.pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.things WHERE location_id = $1 AND serial LIKE $2 ORDER BY serial`,
        [locationId, `BX${n}-%`],
      );
      return rows.map((r) => r.id);
    });
    containerIds.push(...boxes);

    // Things, in batches: the PRNG is replayed from the start, so a resumed run makes the rows
    // a complete one would have.
    const rand = prng(n * 104_729);
    const photoEvery = Math.max(1, Math.floor(size.things / size.photos));
    const now = session.now.getTime();
    let rows: {
      id: string;
      place: string | null;
      container: string | null;
      type: string | null;
      name: string;
      brand: string | null;
      serial: string;
      seen: string;
      tag: string | null;
      photo: boolean;
    }[] = [];
    const flush = async () => {
      if (rows.length === 0) return;
      const batch = rows;
      rows = [];
      await withScope(ctx.pools.app, scope, async (_tx, c) => {
        await c.query(
          `INSERT INTO public.things (id, location_id, place_id, container_id, type_id, name,
                                      brand_id, serial, last_seen_at, created_via)
           SELECT id, $1, place, container, type, name, brand, serial, seen, 'import'
             FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::uuid[],
                         $8::text[], $9::timestamptz[])
                  AS r(id, place, container, type, name, brand, serial, seen)`,
          [
            locationId,
            batch.map((r) => r.id),
            batch.map((r) => r.place),
            batch.map((r) => r.container),
            batch.map((r) => r.type),
            batch.map((r) => r.name),
            batch.map((r) => r.brand),
            batch.map((r) => r.serial),
            batch.map((r) => r.seen),
          ],
        );
        const tagged = batch.filter((r) => r.tag);
        await c.query(
          `INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
           SELECT $1, thing, tag FROM unnest($2::uuid[], $3::uuid[]) AS r(thing, tag)`,
          [locationId, tagged.map((r) => r.id), tagged.map((r) => r.tag)],
        );
        const pictured = batch.filter((r) => r.photo);
        const fileIds = pictured.map(() => newId());
        await c.query(
          `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                     width, height, derivative_state, created_by)
           SELECT id, $1, 'bench', sha, 184320, 'image/jpeg', 'photo', 1600, 1200, 'ready', $2
             FROM unnest($3::uuid[], $4::text[]) AS r(id, sha)`,
          [
            locationId,
            ownerId,
            fileIds,
            pictured.map((r) => createHash('sha256').update(`bench:${r.serial}`).digest('hex')),
          ],
        );
        await c.query(
          `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                                height, bytes)
           SELECT id, 'thumb', $1, 'bench', 320, 240, 9216 FROM unnest($2::uuid[]) AS r(id)`,
          [locationId, fileIds],
        );
        await c.query(
          `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by)
           SELECT gen_random_uuid(), $1, file, thing, 'photo', $2
             FROM unnest($3::uuid[], $4::uuid[]) AS r(file, thing)`,
          [locationId, ownerId, fileIds, pictured.map((r) => r.id)],
        );
      });
    };

    for (let i = 0; i < size.things; i++) {
      // Every draw happens for every row, made or skipped, so the sequence is the same.
      const where = rand();
      const place = pick(rand, placeIds);
      const container = containerIds.length ? pick(rand, containerIds) : null;
      const typeKey = pick(rand, THING_TYPES);
      const name = thingName(rand);
      const branded = rand() < 0.33;
      const brand = pick(rand, brandIds);
      const tag = pick(rand, tagIds);
      const seenDaysAgo = Math.floor(rand() * 1100);
      if (i < counted.things) continue;
      const inRoom = roomId !== null && i < 200;
      const at = inRoom
        ? { place: roomId, container: null }
        : where < 0.1
          ? { place: unplacedId, container: null }
          : where < 0.4 && container
            ? { place: null, container }
            : { place, container: null };
      const photo = i % photoEvery === 0 && Math.floor(i / photoEvery) < size.photos;
      rows.push({
        id: newId(),
        place: at.place,
        container: at.container,
        type: typeKey ? typeId(typeKey) : null,
        name,
        brand: branded ? brand : null,
        serial: `BN${n}-${pad(i)}`,
        seen: new Date(now - seenDaysAgo * 86_400_000).toISOString(),
        tag: i % 2 === 0 ? tag : null,
        photo,
      });
      if (rows.length >= BATCH) {
        await flush();
        report.created += BATCH;
        progress(`${household.name}: ${i + 1} / ${size.things} things`);
      }
    }
    const tail = rows.length;
    await flush();
    report.created += tail;
    if (tail > 0) progress(`${household.name}: ${size.things} / ${size.things} things`);

    // The showcase (Bench 10k only), through the routes: what a thing page shows at its fullest.
    if (index === 0) {
      showcaseThingIds.push(
        ...(await showcase(
          locationId,
          placeIds[0] as string,
          typeId,
          brandIds[0] as string,
          session.now,
        )),
      );
    }

    const final = await withScope(ctx.pools.app, scope, async (_tx, c) => {
      const { rows: r } = await c.query<{ things: number; photos: number }>(
        `SELECT (SELECT count(*)::int FROM public.things WHERE location_id = $1 AND serial LIKE $2)
                  AS things,
                (SELECT count(*)::int FROM public.attachments WHERE location_id = $1
                  AND role = 'photo') AS photos`,
        [locationId, `BN${n}-%`],
      );
      return r[0] ?? { things: 0, photos: 0 };
    });
    locations.push({
      name: household.name,
      id: locationId,
      things: final.things,
      containers: containerIds.length,
      places: placeIds.length + (roomId ? 1 : 0),
      photos: final.photos,
    });
  }

  // --- ANALYZE --------------------------------------------------------------------------------------
  if (opts.ownerUrl) {
    const owner = new pg.Client({ connectionString: opts.ownerUrl });
    // A backend ended under it emits 'error'; unhandled, that ends the process.
    owner.on('error', () => {});
    await owner.connect();
    try {
      await owner.query('ANALYZE');
    } finally {
      await owner.end();
    }
    progress('analysed');
  } else {
    report.notes.push(
      'ANALYZE skipped (no KEPT_OWNER_DATABASE_URL): run it as kept_owner before measuring.',
    );
  }

  report.inventory = locations.map((l) => ({
    location: l.name,
    places: l.places,
    things: l.things + l.containers,
  }));
  report.bench = {
    locations,
    actors: {
      owner: { login: BENCH_CAST.people.benchOwner.email, userId: ownerId },
      member: {
        login: BENCH_CAST.people.benchMember.email,
        userId: await userIdOf('benchMember'),
      },
      viewer: {
        login: BENCH_CAST.people.benchViewer.email,
        userId: await userIdOf('benchViewer'),
      },
    },
    bigRoomId,
    showcaseThingIds,
    seconds: (Date.now() - started) / 1000,
  };
  return report;

  /** Five cars (purchase, odometer with three readings, a photo row) and five chargers linked
   * to them; found by name on a second run. */
  async function showcase(
    locationId: string,
    placeId: string,
    typeIdOf: (key: string) => string,
    brandId: string,
    now: Date,
  ): Promise<string[]> {
    const listed = (await get(
      `/api/v1/things?locationId=${locationId}&q=${encodeURIComponent('Showcase')}&limit=50`,
      'showcase',
    )) as { items: { id: string; name: string }[] };
    const byName = new Map(listed.items.map((t) => [t.name, t.id]));
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const carName = `Showcase car ${i}`;
      let carId = byName.get(carName);
      if (!carId) {
        const car = await post(
          '/api/v1/things',
          {
            locationId,
            placeId,
            name: carName,
            typeId: typeIdOf('car'),
            brandId,
            serial: `SC-${i}`,
            purchase: { purchasedOn: '2025-05-01', currency: 'EGP', price: `${900000 + i}.00` },
          },
          carName,
        );
        carId = String(car.id);
        made();
        const meterId = String(((car.meters as Json[])[0] as Json).id);
        for (const [k, value] of ['1000', '2000', '3000'].entries()) {
          await post(
            `/api/v1/meters/${meterId}/readings`,
            {
              value,
              takenAt: new Date(now.getTime() - (30 - k * 10) * 86_400_000).toISOString(),
            },
            `reading of ${carName}`,
          );
          made();
        }
        await withScope(ctx.pools.app, { userId: ownerId, mfa: false }, async (_tx, c) => {
          const fileId = newId();
          await c.query(
            `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                       width, height, derivative_state, created_by)
             VALUES ($1, $2, 'bench', $3, 184320, 'image/jpeg', 'photo', 1600, 1200, 'ready', $4)`,
            [
              fileId,
              locationId,
              createHash('sha256').update(`showcase:${i}`).digest('hex'),
              ownerId,
            ],
          );
          await c.query(
            `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key,
                                                  width, height, bytes)
             VALUES ($1, 'thumb', $2, 'bench', 320, 240, 9216)`,
            [fileId, locationId],
          );
          await c.query(
            `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by)
             VALUES ($1, $2, $3, $4, 'photo', $5)`,
            [newId(), locationId, fileId, carId, ownerId],
          );
        });
        made();
      }
      const chargerName = `Showcase charger ${i}`;
      let chargerId = byName.get(chargerName);
      if (!chargerId) {
        const charger = await post(
          '/api/v1/things',
          { locationId, placeId, name: chargerName, typeId: typeIdOf('charger') },
          chargerName,
        );
        chargerId = String(charger.id);
        made();
        await post(
          `/api/v1/things/${chargerId}/links`,
          { toThingId: carId, kind: 'accessory_of' },
          `link of ${chargerName}`,
        );
        made();
      }
      ids.push(carId, chargerId);
    }
    return ids;
  }
}

const pad = (i: number) => String(i).padStart(6, '0');

/** The bench part of the report as the CLI prints it. */
export function formatBench(info: BenchInfo): string[] {
  const lines = [''];
  for (const l of info.locations) {
    lines.push(
      `  ${l.name}: ${l.things} things, ${l.containers} containers, ${l.places} places, ${l.photos} photos`,
    );
  }
  lines.push(
    '',
    `  Actors: ${info.actors.owner.login} (owner), ${info.actors.member.login} (member), ${info.actors.viewer.login} (viewer)`,
    `  The 200-thing room: ${info.bigRoomId}`,
    `  Took ${info.seconds.toFixed(1)} s`,
  );
  return lines;
}
