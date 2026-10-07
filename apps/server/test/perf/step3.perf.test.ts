import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../../src/db/scope.js';
import { CHUNK, importChunk } from '../../src/imports/job.js';
import { packageRoot } from '../../src/package-root.js';
import type { TestApp } from '../app.js';
import { type TestDb, testDb } from '../db.js';
import { inbox } from '../inbox.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../people.js';
import { captureOp, syncOps } from '../sync-ops.js';
import { createLocation, type Loc, ok, own, place } from '../things.js';

// Step 3's performance checks (plan T32 "Perf", full mode only: scripts/ci-local.sh `perf`, and
// `pnpm --filter @kept/server exec vitest run --config vitest.perf.config.ts`). The normal test
// run leaves test/perf out (vitest.config.ts).
//
// - A 50-op sync batch: 50 queued captures in one POST /api/v1/sync/ops, the size the phone's
//   sync engine sends (apps/web/src/offline/sync-engine.ts). 3 warm-ups, then 20 timed batches.
// - The inbox's first page (20 items, the default) with 500 open items in the location.
//   5 warm-ups, then 50 timed pages.
// - A CSV import chunk (T18: CHUNK = 200 rows, one transaction, as the import job works it):
//   rows with a two-level place path, a quantity, a date, a price and shop, a brand, two tags and
//   a legacy code each. 1 warm-up chunk, then 3 timed chunks, each its own run.
//
// The requests go through the app in-process (fastify inject): server time, no network, as the
// §3.1 targets are stated. The snapshot build at 10,000 things is the RLS bench's
// (`pnpm --filter @kept/server bench -- --snapshot-only`), which the same ci-local step runs.
//
// None of these has a target in engineering spec §3.1. The limits below are PROVISIONAL, set by
// T32 part B from the figures in docs/perf/2026-09-30-step3.md (M1 Pro, load 5–7), with margin,
// so that a real regression fails and ordinary machine noise doesn't: the batch's p95 was
// 855–1,089 ms (limit 1.5 s), the inbox page's 19–20 ms (limit 100 ms, well under §3.1's page
// p95 of 300 ms), and a 200-row import chunk 2.9–3.5 s, about 63–68 rows a second (limit 10 s).

const BATCH_OPS = 50;
const BATCH_WARMUP = 3;
const BATCH_RUNS = 20;
const INBOX_OPEN = 500;
const INBOX_WARMUP = 5;
const INBOX_RUNS = 50;
const IMPORT_WARMUP = 1;
const IMPORT_RUNS = 3;
const LIMITS = { batchP95Ms: 1_500, inboxPageP95Ms: 100, importChunkMaxMs: 10_000 };

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let home: Loc;
let shelf: string;
const results: Record<string, unknown> = {};

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;

function stats(samples: number[]) {
  const s = [...samples].sort((x, y) => x - y);
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    n: s.length,
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    max: r(s.at(-1) as number),
  };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, louis.userId, 'member');
  shelf = await place(db, home, 'Shelf A');
}, 120_000);

afterAll(async () => {
  await t?.app.close();
  const dir = path.join(packageRoot(), '../../.tmp/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'step3-perf.json');
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`step3 perf: ${JSON.stringify(results)} → ${file}`);
});

describe('step-3 performance (plan T32, full mode only)', () => {
  it(`applies a ${BATCH_OPS}-op capture batch with p95 under ${LIMITS.batchP95Ms} ms`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < BATCH_WARMUP + BATCH_RUNS; i++) {
      const ops = Array.from({ length: BATCH_OPS }, (_, n) =>
        captureOp(home.id, { placeId: shelf }, { name: `Perf thing ${i}-${n}` }),
      );
      const start = performance.now();
      const res = await syncOps(t, louis, ops);
      const ms = performance.now() - start;
      expect(res.statusCode, res.body).toBe(200);
      const outcomes = (res.json() as { results: { outcome: string }[] }).results.map(
        (r) => r.outcome,
      );
      expect(outcomes.filter((o) => o !== 'applied')).toEqual([]);
      if (i >= BATCH_WARMUP) samples.push(ms);
    }
    const s = stats(samples);
    results.syncBatch50 = s;
    expect(s.p95).toBeLessThan(LIMITS.batchP95Ms);
  }, 600_000);

  it(`answers the inbox's first page at ${INBOX_OPEN} open items with p95 under ${LIMITS.inboxPageP95Ms} ms`, async () => {
    // The captured things become AI-named drafts with an open draft item each, as capture and
    // extraction leave them, until the location holds exactly INBOX_OPEN open items.
    await own(
      db,
      `WITH picked AS (
         SELECT t.id FROM public.things t
          WHERE t.location_id = $1 AND t.deleted_at IS NULL AND t.name LIKE 'Perf thing %'
            AND NOT EXISTS (SELECT 1 FROM public.inbox_items i
                             WHERE i.thing_id = t.id AND i.resolved_at IS NULL)
          ORDER BY t.id
          LIMIT greatest(0, $2 - (SELECT count(*) FROM public.inbox_items i
                                   WHERE i.location_id = $1 AND i.resolved_at IS NULL))
       ), drafts AS (
         UPDATE public.things t SET review_state = 'draft',
                field_status = '{"name": {"state": "extracted", "confidence": 0.9}}'
           FROM picked WHERE t.id = picked.id RETURNING t.id
       )
       INSERT INTO public.inbox_items (location_id, kind, thing_id, created_by, payload)
       SELECT $1, 'draft', d.id, $3, '{}' FROM drafts d`,
      [home.id, INBOX_OPEN, louis.userId],
    );
    const open = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.inbox_items
        WHERE location_id = $1 AND resolved_at IS NULL`,
      [home.id],
    );
    expect(open[0]?.n).toBe(INBOX_OPEN);

    const samples: number[] = [];
    for (let i = 0; i < INBOX_WARMUP + INBOX_RUNS; i++) {
      const start = performance.now();
      const res = await inbox(t, louis, `locationId=${home.id}`);
      const ms = performance.now() - start;
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { items: unknown[] }).items).toHaveLength(20);
      if (i >= INBOX_WARMUP) samples.push(ms);
    }
    const s = stats(samples);
    results.inboxFirstPage500 = s;
    expect(s.p95).toBeLessThan(LIMITS.inboxPageP95Ms);
  }, 300_000);
  it(`imports a ${CHUNK}-row CSV chunk in under ${LIMITS.importChunkMaxMs} ms`, async () => {
    const sent: RecordedJob[] = [];
    const ti = await peopleApp(db, { sent });
    const columns = ['Name', 'Place', 'Qty', 'Bought', 'Price', 'Shop', 'Brand', 'Tags', 'Code'];
    const mapping = {
      Name: 'name',
      Place: 'place_path',
      Qty: 'quantity',
      Bought: 'purchased_on',
      Price: 'price',
      Shop: 'vendor',
      Brand: 'brand',
      Tags: 'tags',
      Code: 'legacy_code',
    };
    const chunks: number[] = [];
    try {
      for (let i = 0; i < IMPORT_WARMUP + IMPORT_RUNS; i++) {
        const rows = Array.from({ length: CHUNK }, (_, n) => [
          `Import ${i}-${n}`,
          `Store room ${n % 10} > Shelf ${n % 4}`,
          String((n % 3) + 1),
          `${String((n % 28) + 1).padStart(2, '0')}/03/2024`,
          String(10 + (n % 50)),
          `Shop ${n % 5}`,
          `Brand ${n % 7}`,
          `perf, batch ${n % 3}`,
          `perf-${i}-${n}`,
        ]);
        const created = await call(ti, '/api/v1/imports/csv', {
          as: ibrahim,
          body: {
            locationId: home.id,
            columns,
            rows,
            mapping,
            choices: {
              placeSeparator: '>',
              createPlaces: true,
              dateFormat: 'DD/MM/YYYY',
              defaultTarget: { unplaced: true },
              typeByName: true,
            },
          },
        });
        const { id } = ok(created, 201) as { id: string };
        ok(await call(ti, `/api/v1/imports/${id}/dry-run`, { as: ibrahim, body: {} }));
        ok(await call(ti, `/api/v1/imports/${id}/run`, { as: ibrahim, body: {} }), 202);
        const scope = { userId: ibrahim.userId, mfa: false };
        const start = performance.now();
        const more = await withScope(db.pools.app, scope, (tx, client) =>
          importChunk(tx, client, scope, id),
        );
        const ms = performance.now() - start;
        expect(more).toBe(false);
        const made = await own<{ n: number }>(
          db,
          `SELECT count(*)::int AS n FROM public.things
            WHERE location_id = $1 AND name LIKE $2 AND deleted_at IS NULL`,
          [home.id, `Import ${i}-%`],
        );
        expect(made[0]?.n).toBe(CHUNK);
        if (i >= IMPORT_WARMUP) chunks.push(ms);
      }
    } finally {
      await ti.app.close();
    }
    const s = stats(chunks);
    results.importChunk200 = { ...s, rowsPerSecond: Math.round((CHUNK / s.p50) * 1000 * 10) / 10 };
    expect(s.max).toBeLessThan(LIMITS.importChunkMaxMs);
  }, 600_000);
});
