import { expect } from 'vitest';
import type { TestApp } from '../app.js';
import type { TestDb } from '../db.js';
import { join, type Person, person } from '../people.js';
import { createLocation, type Loc, own, place } from '../things.js';

// Step 4's household fixture for the performance checks (test/perf/step4.perf.test.ts, and
// step5's vehicles.perf.test.ts, which compares the agenda against step 4's recorded figure on the
// same rows). One household location (Home, Africa/Cairo) owned by Ibrahim, with Bruce (admin),
// Louis (member) and Talia (viewer), holding 10,000 things in 20 places, 2,000 warranties (every
// tenth unregistered with a registration deadline), 500 schedules (every 3, 6 or 12 months), 300
// open loans (a fifth borrowed in) to or from Murdock, and 200 expiring documents (150 on things,
// 50 on a place). The location, the people and their memberships go through the front door; the
// rows are bulk-inserted as kept_owner with every trigger firing, then ANALYZEd.

export const THINGS = 10_000;
export const PLACES = 20;
export const WARRANTIES = 2_000;
export const SCHEDULES = 500;
export const LOANS = 300;
export const DOCUMENTS = 200;

export type Household = {
  ibrahim: Person;
  bruce: Person;
  louis: Person;
  talia: Person;
  home: Loc;
  places: string[];
  counted: Record<string, number>;
};

/** Builds the fixture on a reset database. */
export async function seedHousehold(db: TestDb, t: TestApp): Promise<Household> {
  const ibrahim = await person(t, db, 'ibrahim');
  const bruce = await person(t, db, 'bruce');
  const louis = await person(t, db, 'louis');
  const talia = await person(t, db, 'talia');
  const home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  // Verified addresses: the owner and the admin get every reminder by email as well (Q8, Q13).
  await own(db, 'UPDATE auth."user" SET email_verified = true WHERE id = ANY($1::uuid[])', [
    [ibrahim.userId, bruce.userId, louis.userId, talia.userId],
  ]);
  const places: string[] = [];
  for (let i = 1; i <= PLACES; i++) places.push(await place(db, home, `Room ${i}`));
  const murdock = (
    await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Murdock')
       RETURNING id`,
      [home.accountId],
    )
  )[0]?.id as string;

  await own(
    db,
    `INSERT INTO public.things (location_id, place_id, name, created_by)
     SELECT $1, ($2::uuid[])[1 + n % $4], 'Thing ' || lpad(n::text, 5, '0'), $3
       FROM generate_series(1, $5) AS n`,
    [home.id, places, ibrahim.userId, PLACES, THINGS],
  );
  // The things by number: 1..2,000 warranties, then schedules, loans and documents.
  const numbered = `WITH t AS (
      SELECT id, row_number() OVER (ORDER BY name) AS n FROM public.things WHERE location_id = $1),
    today AS (SELECT (now() AT TIME ZONE 'Africa/Cairo')::date AS d)`;
  // Ends from 120 days ago to 609 days on (30-day lead): about 16% ended, 4% expiring.
  await own(
    db,
    `${numbered}
     INSERT INTO public.warranties (location_id, thing_id, kind, provider, starts_on, ends_on,
                                    registered, registration_deadline, created_by)
     SELECT $1, t.id, (ARRAY['manufacturer', 'extended', 'store', 'credit_card'])[1 + t.n % 4],
            'Provider ' || t.n % 20, e.ends_on - 365, e.ends_on,
            t.n % 10 <> 0, CASE WHEN t.n % 10 = 0 THEN today.d + (t.n::int / 10) % 60 - 20 END,
            $2
       FROM t CROSS JOIN today
      CROSS JOIN LATERAL (SELECT today.d + ((t.n::int * 7) % 730) - 120 AS ends_on) e
      WHERE t.n <= $3`,
    [home.id, ibrahim.userId, WARRANTIES],
  );
  await own(
    db,
    `${numbered}
     INSERT INTO public.schedules (location_id, thing_id, name, every_months, anchor_on,
                                   created_by)
     SELECT $1, t.id, 'Service ' || t.n, (ARRAY[3, 6, 12])[1 + t.n % 3],
            today.d - (t.n::int * 13) % 400, $2
       FROM t CROSS JOIN today
      WHERE t.n > $3 AND t.n <= $3 + $4`,
    [home.id, ibrahim.userId, WARRANTIES, SCHEDULES],
  );
  // Due from 30 days ago to 59 days on: about a third overdue.
  await own(
    db,
    `${numbered}
     INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     SELECT $1, t.id, CASE WHEN t.n % 5 = 0 THEN 'in' ELSE 'out' END, $5,
            now() - interval '60 days', today.d + (t.n::int % 90) - 30, $2
       FROM t CROSS JOIN today
      WHERE t.n > $3 AND t.n <= $3 + $4`,
    [home.id, ibrahim.userId, WARRANTIES + SCHEDULES, LOANS, murdock],
  );
  // 150 on things, 50 on a place; expiring from 40 days ago to 359 days on (30-day lead).
  await own(
    db,
    `${numbered}
     INSERT INTO public.expiring_documents (location_id, thing_id, place_id, kind, title,
                                            expires_on, created_by)
     SELECT $1, CASE WHEN t.n % 4 <> 0 THEN t.id END, CASE WHEN t.n % 4 = 0 THEN $5::uuid END,
            (ARRAY['registration', 'insurance', 'licence', 'inspection', 'lease', 'contract'])
              [1 + t.n % 6],
            'Document ' || t.n, today.d + ((t.n::int * 11) % 400) - 40, $2
       FROM t CROSS JOIN today
      WHERE t.n > $3 AND t.n <= $3 + $4`,
    [home.id, ibrahim.userId, WARRANTIES + SCHEDULES + LOANS, DOCUMENTS, places[0]],
  );
  await own(
    db,
    'ANALYZE public.things, public.places, public.warranties, public.schedules, public.loans, public.expiring_documents, public.people, public.memberships, public.locations',
  );
  const counted = await own<Record<string, number>>(
    db,
    `SELECT (SELECT count(*)::int FROM public.things WHERE location_id = $1) AS things,
            (SELECT count(*)::int FROM public.warranties WHERE location_id = $1) AS warranties,
            (SELECT count(*)::int FROM public.schedules WHERE location_id = $1) AS schedules,
            (SELECT count(*)::int FROM public.loans WHERE location_id = $1) AS loans,
            (SELECT count(*)::int FROM public.expiring_documents WHERE location_id = $1)
              AS documents`,
    [home.id],
  );
  expect(counted[0]).toEqual({
    things: THINGS,
    warranties: WARRANTIES,
    schedules: SCHEDULES,
    loans: LOANS,
    documents: DOCUMENTS,
  });
  return { ibrahim, bruce, louis, talia, home, places, counted: counted[0] ?? {} };
}
