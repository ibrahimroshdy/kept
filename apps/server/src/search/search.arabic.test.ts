import { createRequire } from 'node:module';
import { newId, tsQuery } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// The shared normalisation vectors (V20, packages/shared/src/normalize.vectors.json) end to end:
// a thing named with each vector's input is found through GET /api/v1/search by the vector's
// normalised form and by its prefix-stripped form, and a thing named with the normalised form is
// found by the raw input. This runs the JS twin (tsQuery) and SQL (kept.normalize(),
// kept.strip_prefixes(), the search document) against each other on every vector.

type Vector = { in: string; normalized: string; stripped: string; note?: string };
const vectors = createRequire(import.meta.url)('@kept/shared/normalize.vectors.json') as Vector[];
/** Vectors with at least one word to search for. */
const searchable = vectors.filter((v) => tsQuery(v.in) !== null);

let db: TestDb;
let t: TestApp;
let ann: Person;
const byRaw = new Map<number, string>();
const byNormalized = new Map<number, string>();

async function find(q: string): Promise<string[]> {
  const res = await call(
    t,
    `/api/v1/search?${new URLSearchParams({ q, kind: 'things', limit: '200' })}`,
    {
      as: ann,
    },
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { things: { items: { id: string }[] } }).things.items.map((x) => x.id);
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  await ownerTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT p.id FROM public.places p WHERE p.location_id = $1 AND p.is_unplaced`,
      [ann.personalLocationId],
    );
    const unplaced = rows[0]?.id;
    for (const [i, v] of searchable.entries()) {
      for (const [map, name] of [
        [byRaw, v.in],
        [byNormalized, v.normalized],
      ] as const) {
        const id = newId();
        await c.query(
          'INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)',
          [id, ann.personalLocationId, unplaced, name.trim() === '' ? 'blank' : name.slice(0, 200)],
        );
        map.set(i, id);
      }
    }
  });
});

describe('normalize.vectors.json through SQL search (V20)', () => {
  it('has searchable vectors', () => {
    expect(searchable.length).toBeGreaterThan(70);
  });

  it.each(searchable.map((v, i) => [i, v.in, v] as const))(
    'vector %i (%s): found by its normalised and stripped forms, and finds its normalised twin',
    async (i, _label, v) => {
      expect(await find(v.normalized)).toContain(byRaw.get(i));
      expect(await find(v.stripped)).toContain(byRaw.get(i));
      expect(await find(v.in)).toContain(byNormalized.get(i));
    },
  );
});
