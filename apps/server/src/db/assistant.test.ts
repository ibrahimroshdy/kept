import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { expireMemberships } from '../locations/membership-jobs.js';
import { type Scope, withScope, withSystem } from './scope.js';

// Step-6 T5 (0072, 0073): the assistant's private threads, turns, messages, tool results and
// proposals; retention; the search text; and redaction when access ends (engineering spec §1.8,
// §3.3; D22, D23, D123, D164; plan Q11, Q17). Louis is a member of Ibrahim's Home and Garage.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // owns Home and Garage; an instance admin
let garage: string;
let bruce: string; // admin of Home
let louis: string; // member of Home and Garage
let talia: string; // viewer of Home

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, scope, (_tx, c) => fn(c));
const user = (userId: string): Scope => ({ userId, mfa: true });
const text = (t: string) => JSON.stringify([{ type: 'text', text: t }]);
const hex64 = 'a'.repeat(64);

async function thread(userId: string, title: string | null = null): Promise<string> {
  return as(user(userId), async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.assistant_threads (id, user_id, title, locale) VALUES ($1, $2, $3, 'en')`,
      [id, userId, title],
    );
    return id;
  });
}

async function turn(userId: string, threadId: string): Promise<string> {
  return as(user(userId), async (c) => {
    const id = newId();
    await c.query(
      'INSERT INTO public.assistant_turns (id, thread_id, user_id) VALUES ($1, $2, $3)',
      [id, threadId, userId],
    );
    return id;
  });
}

type Msg = { role: 'user' | 'assistant' | 'tool'; parts: string; cited?: string[] };
async function message(userId: string, threadId: string, turnId: string, m: Msg): Promise<string> {
  return as(user(userId), async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.assistant_messages (id, thread_id, turn_id, user_id, role, parts,
                                              cited_location_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, threadId, turnId, userId, m.role, m.parts, m.cited ?? []],
    );
    return id;
  });
}

const proposal = (userId: string, threadId: string, turnId: string, locationId: string) =>
  as(user(userId), async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.assistant_proposals (id, user_id, thread_id, turn_id, location_id,
                                               batch_id, tool, args, args_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'move_thing', '{"thing_id":"x"}', $7,
               now() + interval '10 minutes')`,
      [id, userId, threadId, turnId, locationId, newId(), hex64],
    );
    return id;
  });

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'as-ibrahim', { name: 'Home' });
  garage = (await ownerTx(db, (c) => insertLocation(c, ibrahim, { name: 'Garage' }))).locationId;
  await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]);
  bruce = await seedUser(db, 'as-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'as-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  await addMember(db, garage, louis, 'member');
  talia = await seedUser(db, 'as-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
});

describe('private threads (D23, D123)', () => {
  it('lets a viewer ask, and never hold a proposal', async () => {
    const th = await thread(talia);
    const tu = await turn(talia, th);
    await message(talia, th, tu, { role: 'user', parts: text('Where is the drill?') });
    expect((await pgError(proposal(talia, th, tu, ibrahim.locationId))).code).toBe('42501');
  });

  it("keeps Louis's thread from Home's admin, its owner and the instance admin, and from a token", async () => {
    const th = await thread(louis, 'HDMI cable');
    const tu = await turn(louis, th);
    const msg = await message(louis, th, tu, { role: 'user', parts: text('Where is it?') });
    await as(user(louis), (c) =>
      c.query(
        `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id, tool,
                                                    output)
         VALUES ($1, $2, $3, 'c1', 'where_is', '{"place":"Office drawer"}')`,
        [msg, louis, ibrahim.locationId],
      ),
    );
    await proposal(louis, th, tu, ibrahim.locationId);
    const tables = [
      'assistant_threads',
      'assistant_turns',
      'assistant_messages',
      'assistant_tool_results',
      'assistant_proposals',
    ];
    const count = (scope: Scope) =>
      as(scope, async (c) => {
        const out: number[] = [];
        for (const t of tables) {
          out.push(
            (await c.query(`SELECT 1 FROM public.${t} WHERE user_id = $1`, [louis])).rowCount ?? 0,
          );
        }
        return out;
      });
    expect(await count(user(louis))).toEqual([1, 1, 1, 1, 1]);
    expect(await count(user(bruce))).toEqual([0, 0, 0, 0, 0]);
    expect(await count(user(ibrahim.userId))).toEqual([0, 0, 0, 0, 0]);
    const token = newId();
    await own(
      `INSERT INTO public.api_tokens (id, user_id, kind, name, lookup, hash, scope)
       VALUES ($1, $2, 'personal', 'Shortcuts', 'Abcd1234', $3, 'write')`,
      [token, louis, hex64],
    );
    await own('INSERT INTO public.token_locations (token_id, location_id) VALUES ($1, $2)', [
      token,
      ibrahim.locationId,
    ]);
    expect(await count({ userId: louis, mfa: false, tokenId: token })).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses a row in someone else's thread, a result from a location unseen, and any change to a message", async () => {
    const th = await thread(louis);
    const tu = await turn(louis, th);
    const msg = await message(louis, th, tu, { role: 'user', parts: text('Hi') });
    expect((await pgError(message(bruce, th, tu, { role: 'user', parts: text('Hi') }))).code).toBe(
      '23503',
    );
    const bruceThread = await thread(bruce);
    const bruceTurn = await turn(bruce, bruceThread);
    const bruceMsg = await message(bruce, bruceThread, bruceTurn, { role: 'tool', parts: '[]' });
    const unseen = await pgError(
      as(user(bruce), (c) =>
        c.query(
          `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id,
                                                      tool, output)
           VALUES ($1, $2, $3, 'c1', 'get_thing', '{}')`,
          [bruceMsg, bruce, garage],
        ),
      ),
    );
    expect(unseen.code).toBe('42501');
    // Security review S2: nor an answer citing a location the caller doesn't see.
    const cites = await pgError(
      message(bruce, bruceThread, bruceTurn, {
        role: 'assistant',
        parts: text('The jumper cables are in Box 3.'),
        cited: [garage],
      }),
    );
    expect(cites.code).toBe('42501');
    const edit = await pgError(
      as(user(louis), (c) =>
        c.query(`UPDATE public.assistant_messages SET parts = '[]' WHERE id = $1`, [msg]),
      ),
    );
    expect(edit.code).toBe('42501');
  });

  it('runs one live turn per thread (409 turn_running)', async () => {
    const th = await thread(louis);
    const first = await turn(louis, th);
    expect(await pgError(turn(louis, th))).toMatchObject({
      code: '23505',
      constraint: 'assistant_turns_one_live_uq',
    });
    await as(user(louis), (c) =>
      c.query(
        `UPDATE public.assistant_turns SET status = 'done', finished_at = now() WHERE id = $1`,
        [first],
      ),
    );
    await turn(louis, th);
  });

  it("searches the person's questions and the answers, never tool results (Q17)", async () => {
    const th = await thread(louis, 'Cables');
    const tu = await turn(louis, th);
    await message(louis, th, tu, { role: 'user', parts: text('Where is the HDMI cable?') });
    await message(louis, th, tu, {
      role: 'tool',
      parts: JSON.stringify([
        {
          type: 'tool_result',
          callId: 'c1',
          tool: 'where_is',
          locationIds: [ibrahim.locationId],
          output: { place: 'Zanzibar drawer' },
        },
      ]),
    });
    await message(louis, th, tu, { role: 'assistant', parts: text('In the Office drawer.') });
    const hits = async (q: string) =>
      as(
        user(louis),
        async (c) =>
          (
            await c.query(
              `SELECT 1 FROM public.assistant_threads
              WHERE id = $1 AND search_tsv @@ plainto_tsquery('simple', kept.search_text($2))`,
              [th, q],
            )
          ).rowCount,
      );
    expect([await hits('hdmi'), await hits('office'), await hits('cables')]).toEqual([1, 1, 1]);
    expect(await hits('zanzibar')).toBe(0);
  });
});

describe('retention (D23, Q17)', () => {
  it('takes the lifetime from assistant_thread_days, and each new turn renews it', async () => {
    const days = async (id: string) =>
      Number(
        (
          await own<{ d: string }>(
            `SELECT round(extract(epoch FROM expires_at - now()) / 86400) AS d
               FROM public.assistant_threads WHERE id = $1`,
            [id],
          )
        )[0]?.d,
      );
    expect(await days(await thread(louis))).toBe(90);
    await own(
      `INSERT INTO public.instance_settings (key, value) VALUES ('assistant_thread_days', '10')`,
    );
    const th = await thread(louis);
    expect(await days(th)).toBe(10);
    // 7–365 (instance_settings_values_chk, 0077).
    await own(
      `UPDATE public.instance_settings SET value = '365' WHERE key = 'assistant_thread_days'`,
    );
    await own(
      `UPDATE public.assistant_threads SET expires_at = now() + interval '1 day' WHERE id = $1`,
      [th],
    );
    await turn(louis, th);
    expect(await days(th)).toBe(365);
  });

  it('prunes expired threads with everything in them, and expires stale proposals', async () => {
    const old = await thread(louis);
    const oldTurn = await turn(louis, old);
    await message(louis, old, oldTurn, { role: 'user', parts: text('Old') });
    const live = await thread(louis);
    const liveTurn = await turn(louis, live);
    const p = await proposal(louis, live, liveTurn, ibrahim.locationId);
    await own(
      `UPDATE public.assistant_threads SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [old],
    );
    await own(`UPDATE public.assistant_proposals SET expires_at = now() - interval '1 minute'`);
    const pruned = await withSystem(
      db.pools.system,
      async (_tx, c) =>
        (await c.query('SELECT what, removed::int AS n FROM kept.prune_assistant(now())')).rows,
    );
    expect(pruned).toEqual([
      { what: 'assistant_threads', n: 1 },
      { what: 'assistant_proposals', n: 1 },
    ]);
    expect(
      await own('SELECT 1 FROM public.assistant_messages WHERE thread_id = $1', [old]),
    ).toEqual([]);
    expect(
      (
        await own<{ status: string }>(
          'SELECT status FROM public.assistant_proposals WHERE id = $1',
          [p],
        )
      )[0]?.status,
    ).toBe('expired');
    expect(
      (await pgError(as(user(louis), (c) => c.query('SELECT * FROM kept.prune_assistant(now())'))))
        .code,
    ).toBe('42501');
  });
});

describe('redaction when access ends (D164, Q11)', () => {
  /** Louis's thread: a question, a tool message with one result from Home and one from Garage,
   * an answer citing Home, an answer citing Garage, and an open proposal in each. */
  async function louisThread() {
    const th = await thread(louis, 'Cables');
    const tu = await turn(louis, th);
    await message(louis, th, tu, { role: 'user', parts: text('Where are my cables?') });
    const parts = [{ type: 'tool_call', callId: 'c1', tool: 'where_is', input: { q: 'hdmi' } }];
    await message(louis, th, tu, { role: 'assistant', parts: JSON.stringify(parts) });
    const toolMsg = await message(louis, th, tu, {
      role: 'tool',
      parts: JSON.stringify([
        {
          type: 'tool_result',
          callId: 'c1',
          tool: 'where_is',
          locationIds: [ibrahim.locationId],
          output: { place: 'Office drawer' },
        },
        {
          type: 'tool_result',
          callId: 'c2',
          tool: 'where_is',
          locationIds: [garage],
          output: { place: 'Box 3' },
        },
      ]),
    });
    await as(user(louis), (c) =>
      c.query(
        `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id, tool,
                                                    output)
         VALUES ($1, $2, $3, 'c1', 'where_is', '{"place":"Office drawer"}'),
                ($1, $2, $4, 'c2', 'where_is', '{"place":"Box 3"}')`,
        [toolMsg, louis, ibrahim.locationId, garage],
      ),
    );
    const homeAnswer = await message(louis, th, tu, {
      role: 'assistant',
      parts: text('The HDMI cable is in the Office drawer.'),
      cited: [ibrahim.locationId],
    });
    const garageAnswer = await message(louis, th, tu, {
      role: 'assistant',
      parts: text('The jumper cables are in Box 3.'),
      cited: [garage],
    });
    await as(user(louis), (c) =>
      c.query(`UPDATE public.assistant_turns SET status = 'done' WHERE id = $1`, [tu]),
    );
    const tu2 = await turn(louis, th);
    const homeProposal = await proposal(louis, th, tu2, ibrahim.locationId);
    const garageProposal = await proposal(louis, th, tu2, garage);
    return { th, toolMsg, homeAnswer, garageAnswer, homeProposal, garageProposal };
  }

  const state = async (ids: Awaited<ReturnType<typeof louisThread>>) => {
    const parts = async (id: string) =>
      (
        await own<{ parts: unknown }>('SELECT parts FROM public.assistant_messages WHERE id = $1', [
          id,
        ])
      )[0]?.parts;
    const results = await own<{ call_id: string; output: unknown; redacted: boolean }>(
      `SELECT call_id, output, redacted_at IS NOT NULL AS redacted
         FROM public.assistant_tool_results WHERE message_id = $1 ORDER BY call_id`,
      [ids.toolMsg],
    );
    const status = async (id: string) =>
      (
        await own<{ status: string }>(
          'SELECT status FROM public.assistant_proposals WHERE id = $1',
          [id],
        )
      )[0]?.status;
    const search = async (q: string) =>
      (
        await own(
          `SELECT 1 FROM public.assistant_threads
            WHERE id = $1 AND search_tsv @@ plainto_tsquery('simple', kept.search_text($2))`,
          [ids.th, q],
        )
      ).length;
    return {
      results,
      tool: await parts(ids.toolMsg),
      homeAnswer: await parts(ids.homeAnswer),
      garageAnswer: await parts(ids.garageAnswer),
      proposals: [await status(ids.homeProposal), await status(ids.garageProposal)],
      search: { hdmi: await search('hdmi'), jumper: await search('jumper') },
    };
  };

  const redacted = { type: 'redacted', reason: 'access_ended' };

  it("redacts Home's results and answers when Louis is removed from Home, and leaves Garage's", async () => {
    const ids = await louisThread();
    // A proposal of Home's already confirmed keeps its arguments and result until then.
    const th2 = await thread(louis, 'Done');
    const done = await proposal(louis, th2, await turn(louis, th2), ibrahim.locationId);
    await own(
      `UPDATE public.assistant_proposals SET status = 'confirmed', result = '{"ok": true}'
        WHERE id = $1`,
      [done],
    );
    await as(user(bruce), (c) =>
      c.query('DELETE FROM public.memberships WHERE user_id = $1 AND location_id = $2', [
        louis,
        ibrahim.locationId,
      ]),
    );
    const s = await state(ids);
    expect(s.results).toEqual([
      { call_id: 'c1', output: null, redacted: true },
      { call_id: 'c2', output: { place: 'Box 3' }, redacted: false },
    ]);
    expect(s.tool).toEqual([
      redacted,
      {
        type: 'tool_result',
        callId: 'c2',
        tool: 'where_is',
        locationIds: [garage],
        output: { place: 'Box 3' },
      },
    ]);
    expect(s.homeAnswer).toEqual([redacted]);
    expect(s.garageAnswer).toEqual([{ type: 'text', text: 'The jumper cables are in Box 3.' }]);
    expect(s.proposals).toEqual(['cancelled', 'open']);
    // Security review S1: every proposal of Home's, whatever its status, keeps nothing of it.
    const kept = await own<{ id: string; status: string; args: unknown; result: unknown }>(
      `SELECT id, status, args, result FROM public.assistant_proposals
        WHERE id = ANY ($1::uuid[]) ORDER BY id`,
      [[ids.homeProposal, ids.garageProposal, done]],
    );
    expect(Object.fromEntries(kept.map((p) => [p.id, [p.status, p.args, p.result]]))).toEqual({
      [ids.homeProposal]: ['cancelled', {}, null],
      [done]: ['confirmed', {}, null],
      [ids.garageProposal]: ['open', { thing_id: 'x' }, null],
    });
    expect(s.search).toEqual({ hdmi: 0, jumper: 1 });
    // Nothing names the location in what is left.
    expect(JSON.stringify([s.tool, s.homeAnswer])).not.toContain(ibrahim.locationId);
  });

  it('redacts when Louis leaves, when expire-memberships ends him, and when a location is purged', async () => {
    const leave = await louisThread();
    await as(user(louis), (c) =>
      c.query('DELETE FROM public.memberships WHERE user_id = $1 AND location_id = $2', [
        louis,
        ibrahim.locationId,
      ]),
    );
    expect((await state(leave)).homeAnswer).toEqual([redacted]);

    await addMember(db, ibrahim.locationId, louis, 'member');
    const expire = await louisThread();
    await own(
      `UPDATE public.memberships SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND location_id = $2`,
      [louis, ibrahim.locationId],
    );
    await expireMemberships(db.pools);
    expect((await state(expire)).homeAnswer).toEqual([redacted]);

    await addMember(db, ibrahim.locationId, louis, 'member');
    const purge = await louisThread();
    await own('DELETE FROM public.locations WHERE id = $1', [garage]);
    const s = await state(purge);
    expect(s.garageAnswer).toEqual([redacted]);
    expect(s.results.find((r) => r.call_id === 'c2')).toEqual({
      call_id: 'c2',
      output: null,
      redacted: true,
    });
  });

  it('kept.redact_assistant_for(): the user, an admin of the location, or the system; once', async () => {
    const ids = await louisThread();
    const call = (scope: Scope | 'system') => {
      const sql = 'SELECT kept.redact_assistant_for($1, $2) AS n';
      const args = [louis, garage];
      return scope === 'system'
        ? withSystem(db.pools.system, async (_tx, c) => (await c.query(sql, args)).rows[0]?.n)
        : as(scope, async (c) => (await c.query(sql, args)).rows[0]?.n);
    };
    expect((await pgError(call(user(bruce)))).code).toBe('42501');
    expect(await call(user(ibrahim.userId))).toBe(3);
    expect(await call('system')).toBe(0);
    expect((await state(ids)).proposals).toEqual(['open', 'cancelled']);
  });
});
