import { createHash } from 'node:crypto';
import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 3's fixture rows for the leak test (test/leak.test.ts, fillTenant()), after step 2's
// (test/leak-inventory.ts): one or more rows in every capture, sync, AI and label table, for each
// tenant. Written as kept_owner inside fillTenant()'s transaction.

/** Fills `t`'s account and location. The inventory rows (fillInventory) are already there. */
export async function fillCapture(c: pg.ClientBase, t: Tenant, label: string): Promise<void> {
  const one = async (sql: string, values: unknown[]) =>
    (await c.query<{ id: string }>(sql, values)).rows[0]?.id as string;
  const thing = await one('SELECT id FROM public.things WHERE location_id = $1 AND name = $2', [
    t.locationId,
    `${label} thing`,
  ]);
  const box = await one('SELECT id FROM public.things WHERE location_id = $1 AND name = $2', [
    t.locationId,
    `${label} box`,
  ]);
  const inside = await one('SELECT id FROM public.things WHERE location_id = $1 AND name = $2', [
    t.locationId,
    `${label} inside`,
  ]);

  // Sync foundations (T4): a legacy code on the room thing, a box check with one line on the
  // box, and an op in the tenant user's ledger.
  await c.query(
    `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
     VALUES ($1, 'homebox', 'asset', $2, $3)`,
    [t.locationId, `${label.toUpperCase()}-000-001`, thing],
  );
  // Own codes (T17a): the options and a counter, and an own code on the room thing.
  await c.query(
    `INSERT INTO public.own_code_settings (location_id, numbering, prefix, pad, rule_pattern,
                                           rule_message, rule_example)
     VALUES ($1, true, $2, 4, '[A-Z]+-[0-9]{4}', 'Letters, a hyphen, four digits.', 'GAR-0001')`,
    [t.locationId, `${label.toUpperCase()}-`],
  );
  await c.query(
    `INSERT INTO public.own_code_counters (location_id, prefix, last_number) VALUES ($1, $2, 7)`,
    [t.locationId, `${label.toUpperCase()}-`],
  );
  await c.query(
    `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
     VALUES ($1, 'own', '', $2, $3)`,
    [t.locationId, `${label.toUpperCase()}-OWN-0001`, thing],
  );
  const check = newId();
  await c.query(
    `INSERT INTO public.box_checks (id, location_id, container_id, checked_by, checked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [check, t.locationId, box, t.userId],
  );
  await c.query(
    `INSERT INTO public.box_check_lines (box_check_id, location_id, thing_id, expected_qty,
                                         found_qty)
     VALUES ($1, $2, $3, 1, 1)`,
    [check, t.locationId, inside],
  );
  await c.query(
    `INSERT INTO public.sync_ops (user_id, idempotency_key, client_id, location_id, op,
                                  payload_version, client_version, taken_at, request_hash, outcome)
     VALUES ($1, $2, $3, $4, 'mark_seen', 1, '0.3.0', now(), $5, 'applied')`,
    [
      t.userId,
      `op-${label}-${newId()}`,
      newId(),
      t.locationId,
      createHash('sha256').update(`${label}-op`).digest('hex'),
    ],
  );

  // Capture records (T5): an extraction of the room thing's photo with its open inbox item; a
  // template shared into the location; an import run and a source id; a PDF on the room thing
  // with its text.
  const photo = await one(
    `SELECT id FROM public.attachments WHERE thing_id = $1 AND role = 'photo' LIMIT 1`,
    [thing],
  );
  const extraction = newId();
  await c.query(
    `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, mode, status,
                                     requested_by)
     VALUES ($1, $2, $3, $4, 'thing', 'succeeded', $5)`,
    [extraction, t.locationId, photo, thing, t.userId],
  );
  await c.query(
    `INSERT INTO public.inbox_items (location_id, kind, thing_id, extraction_id, created_by)
     VALUES ($1, 'draft', $2, $3, $4)`,
    [t.locationId, thing, extraction, t.userId],
  );
  const template = newId();
  await c.query(
    `INSERT INTO public.templates (id, owner_account_id, name, payload, created_by)
     VALUES ($1, $2, $3, '{"quantity": "1"}', $4)`,
    [template, t.accountId, `${label} template`, t.userId],
  );
  await c.query(
    `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
     VALUES ($1, $2, $3)`,
    [template, t.accountId, t.locationId],
  );
  const run = newId();
  await c.query(
    `INSERT INTO public.import_runs (id, location_id, source, created_by) VALUES ($1, $2, 'csv', $3)`,
    [run, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type, entity_id,
                                           run_id)
     VALUES ($1, 'csv', 'row-1', 'thing', $2, $3)`,
    [t.locationId, thing, run],
  );
  const pdf = newId();
  await c.query(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'ready', $5)`,
    [
      pdf,
      t.locationId,
      `f/${t.locationId}/${pdf}`,
      createHash('sha256').update(`${label}-pdf-${pdf}`).digest('hex'),
      t.userId,
    ],
  );
  await c.query(
    `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
     VALUES ($1, $2, $3, 'warranty_doc', $4)`,
    [t.locationId, pdf, thing, t.userId],
  );
  await c.query(
    `INSERT INTO public.file_text (file_id, location_id, source, text)
     VALUES ($1, $2, 'pdf', $3)`,
    [pdf, t.locationId, `${label} warranty card`],
  );

  await fillAi(c, t, label, thing);

  // Labels (T7): a printed batch holding the room thing's code, and a blank code of the location.
  const code = await one('SELECT code AS id FROM public.short_ids WHERE thing_id = $1 LIMIT 1', [
    thing,
  ]);
  const batch = newId();
  await c.query(
    `INSERT INTO public.label_batches (id, location_id, kind, stock, code_count, created_by)
     VALUES ($1, $2, 'things', 'thermal_50x30', 1, $3)`,
    [batch, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.label_batch_codes (batch_id, location_id, code, sort) VALUES ($1, $2, $3, 1)`,
    [batch, t.locationId, code],
  );
  await c.query(
    `INSERT INTO public.short_ids (code, location_id, state, is_primary) VALUES ($1, $2, 'blank', false)`,
    [randomShortCode(), t.locationId],
  );
}

/** AI (T6): an account key and a personal key, an account cap, a location cap and a member cap,
 * a price in two versions, a ledger row written through kept.ai_settle (so the counters have
 * rows), a held payer slot, a breaker and a provider window, and a month of totals. The doors
 * check their caller, so this runs as the tenant's user. */
async function fillAi(c: pg.ClientBase, t: Tenant, label: string, thing: string): Promise<void> {
  await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.mfa', 'true', true)", [
    t.userId,
  ]);
  const provider = newId();
  await c.query(
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, key_hint, models, created_by)
     VALUES ($1, 'account', $2, 'groq', '{"v": 1, "c": "not a key"}', 1, 'ab12',
             '{"vision": "qwen/qwen3.8-27b"}', $3)`,
    [provider, t.accountId, t.userId],
  );
  await c.query(
    `INSERT INTO public.ai_providers (scope, user_id, kind, key_ciphertext, key_version, models,
                                      created_by)
     VALUES ('user', $1, 'openai', '{"v": 1, "c": "not a key"}', 1, '{"vision": "gpt-v"}', $1)`,
    [t.userId],
  );
  await c.query(
    `INSERT INTO public.ai_budgets (scope, owner_account_id, monthly_cap_amount, cap_currency,
                                    set_by)
     VALUES ('account', $1, 5, 'USD', $2)`,
    [t.accountId, t.userId],
  );
  await c.query(
    `INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, tokens_per_month, set_by)
     VALUES ('location', $1, $2, 1000000, $3)`,
    [t.accountId, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.ai_budgets (scope, owner_account_id, user_id, tokens_per_month, set_by)
     VALUES ('member', $1, $2, 500000, $2)`,
    [t.accountId, t.userId],
  );
  const model = `${label}-vision`;
  await c.query(
    `INSERT INTO public.ai_model_prices (provider_kind, model, version, input_per_mtok,
                                         output_per_mtok, currency, effective_from, superseded_at,
                                         source, created_by)
     VALUES ('groq', $1, 1, 0.1, 0.3, 'USD', now() - interval '2 days', now() - interval '1 day',
             'admin', $2),
            ('groq', $1, 2, 0.2, 0.6, 'USD', now() - interval '1 day', NULL, 'admin', $2)`,
    [model, t.userId],
  );
  const one = async (sql: string, values: unknown[]) =>
    (await c.query<{ id: string }>(sql, values)).rows[0]?.id as string;
  const price = await one(
    'SELECT id FROM public.ai_model_prices WHERE model = $1 AND superseded_at IS NULL',
    [model],
  );
  const ctx = {
    paying_scope: 'account',
    paying_account_id: t.accountId,
    location_id: t.locationId,
    owner_account_id: t.accountId,
    user_id: t.userId,
    budget_task: 'extraction',
    estimate_tokens: 3000,
    job_id: `leak-${label}`,
    request_id: `req-${label}`,
    task: 'extract_thing',
    provider_id: provider,
    provider_kind: 'groq',
    model,
    thing_id: thing,
  };
  const reserved = await c.query<{ call_id: string; slot: number }>(
    'SELECT call_id, slot FROM kept.ai_reserve($1)',
    [JSON.stringify(ctx)],
  );
  const res = reserved.rows[0] as { call_id: string; slot: number };
  await c.query('SELECT * FROM kept.ai_settle($1, $2, $3, $4)', [
    JSON.stringify({
      ...ctx,
      reservation: { id: res.call_id, slot: res.slot, estimate_tokens: 3000 },
    }),
    JSON.stringify({
      sent: true,
      input_tokens: 2500,
      output_tokens: 200,
      rl_remaining_tokens: 5000,
      rl_reset_at: new Date(Date.now() + 30_000).toISOString(),
    }),
    'ok',
    JSON.stringify({ amount: '0.0006', currency: 'USD', source: 'price_table', price_id: price }),
  ]);
  // A reservation still in flight: its payer slot is held.
  await c.query('SELECT * FROM kept.ai_reserve($1)', [
    JSON.stringify({ ...ctx, job_id: `leak-${label}-2` }),
  ]);
  await c.query(`SELECT kept.ai_trip($1, now() - interval '1 minute', 'rate_limited')`, [provider]);
  await c.query(
    `INSERT INTO public.ai_usage_months (month, paying_scope, paying_account_id, location_id,
                                         owner_account_id, user_id, task, provider_kind, model,
                                         cost_currency, calls, sent_calls, tokens, images,
                                         cost_amount, unknown_cost_calls)
     VALUES ('2025-01-01', 'account', $1, $2, $1, $3, 'extract_thing', 'groq', $4, 'USD', 3, 3,
             9000, 3, 0.002, 0)`,
    [t.accountId, t.locationId, t.userId, model],
  );
  await c.query("SELECT set_config('app.user_id', '', true)");
}
