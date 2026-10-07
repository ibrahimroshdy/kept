import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgDriver from 'pg';
import { describe, expect, it } from 'vitest';
import { ScopeError } from '../db/scope.js';
import {
  AppError,
  isDatabaseUnavailable,
  notFound,
  safeErrorForLog,
  toErrorReply,
} from './errors.js';

// Task 16: the error shape and the Postgres mapping (engineering spec §7.7, D81, D178).

const pg = (code: string, constraint?: string, message = 'boom') =>
  Object.assign(new Error(message), { code, severity: 'ERROR', constraint });

/** How DrizzleQueryError carries the driver's error. */
const wrapped = (cause: Error) =>
  Object.assign(new Error('Failed query: insert ... params: secret-value'), {
    name: 'DrizzleQueryError',
    cause,
  });

describe('toErrorReply()', () => {
  it('passes an AppError through, with hint and extra fields', () => {
    const reply = toErrorReply(
      new AppError('precondition_failed', 412, 'Reload.', { conflicts: ['name'] }),
    );
    expect(reply).toEqual({
      status: 412,
      body: {
        error: 'This changed since you opened it.',
        hint: 'Reload.',
        code: 'precondition_failed',
        conflicts: ['name'],
      },
    });
  });

  it('never lets extra fields overwrite error or code', () => {
    const reply = toErrorReply(new AppError('conflict', 409, undefined, { code: 'x', error: 'y' }));
    expect(reply.body).toMatchObject({
      code: 'conflict',
      error: 'That conflicts with the current state.',
    });
  });

  it.each([
    ['42501', undefined, 404, 'not_found'],
    ['23505', 'places_pkey', 404, 'not_found'],
    ['23505', 'idempotency_keys_user_id_key_pk', 404, 'not_found'],
    ['23505', 'invites_token_hash_unique', 409, 'conflict'],
    ['23503', 'memberships_user_id_user_id_fk', 409, 'conflict'],
    ['23001', 'places_parent_fk', 409, 'conflict'],
    ['23514', 'locations_owner_membership', 409, 'conflict'],
    ['23514', 'locations_personal_owner_only', 409, 'conflict'],
    ['23514', 'places_no_loop', 409, 'conflict'],
    ['23514', 'places_unplaced_fixed', 409, 'conflict'],
    ['23514', 'locations_personal_undeletable', 409, 'conflict'],
    ['42501', 'invite_invalid', 404, 'invite_invalid'],
    ['23505', 'memberships_location_user_uq', 409, 'conflict'],
    ['23514', 'locations_latitude_chk', 400, 'validation'],
    ['23502', undefined, 400, 'validation'],
    ['22P02', undefined, 400, 'validation'],
    ['40001', undefined, 409, 'conflict'],
    ['XX000', undefined, 500, 'internal'],
    ['P0001', 'cap_above_account', 400, 'cap_above_account'],
    ['P0001', 'ai_cap_still_reached', 409, 'ai_cap_still_reached'],
    ['P0001', undefined, 500, 'internal'],
    // Step 4 (T2): the T5 names with a code of their own.
    ['23514', 'warranties_quantity_one', 409, 'quantity_not_one'],
    ['23514', 'claims_transition', 409, 'invalid_transition'],
    ['23505', 'claims_one_repair_uq', 409, 'thing_in_repair'],
    ['23505', 'loans_one_open_uq', 409, 'already_on_loan'],
    ['23514', 'things_move_open_loan', 409, 'open_loan'],
    ['23514', 'things_move_in_repair', 409, 'open_claim'],
    ['23514', 'calendar_feeds_cap', 409, 'conflict'],
    // Step 5 (T2): one owner per reading (Q11).
    ['23505', 'fuel_entries_reading_uq', 409, 'conflict'],
    ['23505', 'service_records_reading_uq', 409, 'conflict'],
    // Step 7 (T2): Phase A's trigger names.
    ['23514', 'import_runs_target_fixed', 409, 'conflict'],
    ['23514', 'stock_rules_consumable', 409, 'not_consumable'],
  ])('maps SQLSTATE %s (%s) to %i %s, bare or wrapped', (code, constraint, status, errCode) => {
    for (const err of [pg(code, constraint), wrapped(pg(code, constraint))]) {
      const reply = toErrorReply(err);
      expect(reply.status).toBe(status);
      expect(reply.body.code).toBe(errCode);
    }
  });

  it('gives the named trigger constraints a hint', () => {
    expect(toErrorReply(pg('23514', 'places_no_loop')).body.hint).toMatch(/under itself/);
    expect(toErrorReply(pg('23514', 'locations_personal_undeletable')).body.hint).toMatch(
      /Personal/,
    );
    expect(toErrorReply(pg('23505', 'memberships_location_user_uq')).body.hint).toMatch(/already/);
    expect(toErrorReply(pg('23514', 'warranties_quantity_one')).body).toMatchObject({
      code: 'quantity_not_one',
      error: 'A warranty is for a single thing.',
      hint: expect.stringMatching(/^Split it first/),
    });
  });

  it('gives the step-7 codes their sentences (T2)', () => {
    expect(toErrorReply(new AppError('archive_invalid', 400)).body.error).toBe(
      "Kept can't read this archive.",
    );
    expect(toErrorReply(pg('23514', 'stock_rules_consumable')).body).toMatchObject({
      code: 'not_consumable',
      hint: 'Only things you run out of can have a minimum.',
    });
  });

  it('gives the step-5 codes their sentences (T1)', () => {
    expect(toErrorReply(new AppError('reading_owned', 409)).body.error).toBe(
      'Change this reading from its fuel entry or service.',
    );
    expect(toErrorReply(new AppError('service_draft', 409)).body.error).toBe(
      'Finish logging this service first.',
    );
    expect(toErrorReply(new AppError('fuel_needs_meter', 400)).body.error).toBe(
      'This thing has no meter for the odometer.',
    );
    expect(toErrorReply(pg('23505', 'fuel_entries_reading_uq')).body.hint).toMatch(/fuel entry/);
  });

  it('maps a collision on a primary key to exactly the body of a missing row (§7.7)', () => {
    expect(toErrorReply(wrapped(pg('23505', 'places_pkey')))).toEqual(toErrorReply(notFound()));
  });

  it('treats ScopeError and anything unknown as a bare 500, with nothing of the original', () => {
    for (const err of [
      new ScopeError('scope.userId must be a UUID'),
      new Error('secret detail'),
      'x',
    ]) {
      const reply = toErrorReply(err);
      expect(reply).toEqual({
        status: 500,
        body: { error: 'Something went wrong.', code: 'internal' },
      });
    }
  });

  it('maps Fastify validation errors to 400 validation, naming paths but no values', () => {
    const err = Object.assign(new Error('body/name Too small: "hunter2"'), {
      statusCode: 400,
      validation: [{ instancePath: '/name', message: 'Too small: "hunter2"' }],
      validationContext: 'body',
    });
    const reply = toErrorReply(err);
    expect(reply).toEqual({
      status: 400,
      body: { error: 'The request is not valid.', hint: 'Check body.name.', code: 'validation' },
    });
  });

  it('keeps 4xx statuses from Fastify with an enum code', () => {
    const tooLarge = Object.assign(new Error('too large'), { statusCode: 413 });
    expect(toErrorReply(tooLarge)).toMatchObject({ status: 413, body: { code: 'validation' } });
    const limited = Object.assign(new Error('slow down'), { statusCode: 429 });
    expect(toErrorReply(limited)).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
  });
});

describe('the database out of reach', () => {
  const down = {
    status: 503,
    body: {
      error: "Kept can't reach its database right now. Try again in a minute.",
      code: 'database_unavailable',
    },
  };
  const fatal = (code: string) =>
    Object.assign(new Error('boom'), { code, severity: 'FATAL', constraint: undefined });
  const socket = (code: string) => Object.assign(new Error(`connect ${code}`), { code });

  it('answers 503 database_unavailable, not a 500, for connection errors', () => {
    for (const err of [
      fatal('57P01'), // terminating connection due to administrator command
      fatal('57P02'), // crash shutdown (the PANIC of 2026-09-30)
      fatal('57P03'), // the database system is starting up
      fatal('53300'), // too many connections
      pg('08006'), // connection failure
      pg('08001'), // unable to connect
      fatal('55000'), // database … is not currently accepting connections
      socket('ECONNREFUSED'),
      socket('ECONNRESET'),
      socket('ETIMEDOUT'),
      Object.assign(new AggregateError([socket('ECONNREFUSED')], ''), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
      new Error('Connection terminated due to connection timeout', {
        cause: new Error('Connection terminated unexpectedly'),
      }),
      wrapped(fatal('57P01')),
      wrapped(socket('ECONNREFUSED')),
    ]) {
      expect(isDatabaseUnavailable(err), String(err)).toBe(true);
      expect(toErrorReply(err)).toEqual(down);
    }
  });

  it('leaves errors the request caused alone', () => {
    expect(isDatabaseUnavailable(pg('55000'))).toBe(false); // an ERROR, not the refused session
    expect(isDatabaseUnavailable(pg('23505', 'tags_name_uq'))).toBe(false);
    expect(isDatabaseUnavailable(pg('57014'))).toBe(false); // statement timeout
    expect(isDatabaseUnavailable(new Error('Client was closed and is not queryable'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('secret detail'))).toBe(false);
    expect(toErrorReply(pg('57014')).status).toBe(500);
  });

  it('recognises a real refused connection from pg', async () => {
    // A port nothing listens on: open one, note it, close it.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));
    for (const host of ['127.0.0.1', 'localhost']) {
      const client = new pgDriver.Client({ host, port, user: 'x', database: 'x' });
      const err = await client.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isDatabaseUnavailable(err), `${host}: ${String(err)}`).toBe(true);
    }
  });
});

describe('safeErrorForLog()', () => {
  it('keeps a pg error to its codes and names', () => {
    const err = Object.assign(
      pg('22P02', undefined, 'invalid input syntax for type uuid: "s3cret"'),
      {
        detail: 'Key (email)=(a@b.c)',
        table: 'places',
      },
    );
    const logged = JSON.stringify(safeErrorForLog(wrapped(err)));
    expect(logged).not.toMatch(/s3cret|a@b\.c|secret-value/);
    expect(safeErrorForLog(err)).toMatchObject({ code: '22P02', table: 'places' });
  });

  it('withholds a DrizzleQueryError message (it holds the parameters)', () => {
    const err = Object.assign(new Error('Failed query: x params: secret-value'), {
      name: 'DrizzleQueryError',
    });
    expect(JSON.stringify(safeErrorForLog(err))).not.toContain('secret-value');
  });

  it("logs pg-boss's plain-object copy of an error by its message, not [object Object]", () => {
    const err = new Error('Connection terminated unexpectedly');
    // What pg-boss's worker emits (manager.js onError).
    const copy = { ...err, message: err.message, stack: err.stack, queue: 'purge', worker: 'w1' };
    expect(safeErrorForLog(copy)).toEqual({
      type: 'Error',
      message: 'Connection terminated unexpectedly',
      stack: err.stack,
      queue: 'purge',
      worker: 'w1',
    });
    const drizzle = { name: 'DrizzleQueryError', message: 'Failed query: x params: secret-value' };
    expect(JSON.stringify(safeErrorForLog(drizzle))).not.toContain('secret-value');
  });
});

describe('state conflicts the database raises (review #3)', () => {
  const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  /** Raised only when the server itself is wrong (a bad audit row), never by a request: a 500 or
   * a 400 is the right answer for them, so they get no hint. */
  const INTERNAL = new Set([
    'audit_events_default_has_rows',
    // The AI call ledger's twin (0040): raised to the ai-maintenance job, never a request.
    'llm_calls_default_has_rows',
    'audit_events_undo_of',
    'audit_events_undo_window',
  ]);
  /** CHECK constraints that describe the state of other rows, not the shape of the input. */
  const STATE_CHECKS = ['type_fields_secret_text_chk'];

  /** Every constraint name a migration raises as a check violation. */
  function raisedCheckViolations(): string[] {
    const out = new Set<string>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
      for (const m of sql.matchAll(/USING\s[^;]*?;/gs)) {
        const using = m[0];
        const code = /ERRCODE\s*=\s*'([0-9a-z_]+)'/i.exec(using)?.[1];
        const name = /CONSTRAINT\s*=\s*'([a-z_]+)'/.exec(using)?.[1];
        if (name && (code === 'check_violation' || code === '23514')) out.add(name);
      }
    }
    return [...out].sort();
  }

  it('finds the raised names (so the check below is not vacuous)', () => {
    expect(raisedCheckViolations()).toEqual(
      expect.arrayContaining([
        'places_no_loop',
        'type_fields_secret_fixed',
        'types_field_group_chk',
      ]),
    );
  });

  it('answers every one a request can hit with 409 conflict and a hint, not 400', () => {
    const names = [...raisedCheckViolations().filter((n) => !INTERNAL.has(n)), ...STATE_CHECKS];
    const wrong = names.filter((n) => {
      const reply = toErrorReply(pg('23514', n));
      return reply.status !== 409 || !reply.body.hint;
    });
    expect(wrong).toEqual([]);
  });
});
