import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgBossSchemaVersion } from '../jobs/install.js';
import { MigrateError, migrationsFolder, runMigrations } from './migrate.js';

// One row per journal entry: the count grows with every migration, so read it, don't hardcode it.
const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
) as { entries: unknown[] };
const MIGRATION_COUNT = journal.entries.length;

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/kept';

// Every test here migrates a fresh database from nothing; since step 2 that is twice the
// migrations, and under a full parallel run it outgrows the 5 s / 10 s defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Who may call each function in schema kept. PUBLIC has EXECUTE on none (migration 0000), and
// kept_auth on none. Trigger and maintenance functions are kept_owner's alone: a trigger
// function needs no EXECUTE grant for the role whose statement fires it.
// The RLS membership functions and the definer paths past the policies (0006) are kept_app's
// alone; ensure_audit_partitions (0005) is kept_system's; ensure_account (0007) is both roles'.
// test/leak.test.ts also records which of these are SECURITY DEFINER.
const APP_AND_SYSTEM = ['kept_app', 'kept_system'];
const APP_ONLY = ['kept_app'];
const SYSTEM_ONLY = ['kept_system'];
const OWNER_ONLY: string[] = [];
const KEPT_FUNCTION_EXECUTE: Record<string, string[]> = {
  // regprocedure quotes a name that is also a keyword (NORMALIZE).
  'kept."normalize"(text)': APP_AND_SYSTEM,
  'kept.accept_invite(text,text)': APP_ONLY,
  'kept.add_managed_member(uuid,uuid,text,timestamp with time zone)': APP_ONLY,
  'kept.admin_account_ids()': APP_ONLY,
  'kept.admin_location_ids()': APP_ONLY,
  'kept.admin_user_summaries(uuid[])': APP_ONLY,
  'kept.audit_default_partition_rows()': SYSTEM_ONLY,
  'kept.can_reveal_secret(uuid,uuid)': APP_ONLY,
  'kept.clear_secret(uuid,uuid,text)': APP_ONLY,
  'kept.clear_tombstone_on_arrival()': OWNER_ONLY,
  'kept.check_location_owner()': OWNER_ONLY,
  'kept.check_place_parent()': OWNER_ONLY,
  'kept.check_thing_container()': OWNER_ONLY,
  'kept.claim_invite(text,text)': APP_ONLY,
  'kept.claim_first_instance_admin(uuid)': SYSTEM_ONLY,
  'kept.convert_container_to_place(uuid,uuid)': APP_ONLY,
  'kept.convert_place_to_container(uuid,uuid)': APP_ONLY,
  'kept.copy_file(uuid,uuid)': OWNER_ONLY,
  'kept.copy_purchase_line(uuid,uuid,uuid)': OWNER_ONLY,
  'kept.create_audit_partition(date)': OWNER_ONLY,
  'kept.create_managed_profile(uuid,text)': APP_ONLY,
  'kept.current_mfa()': APP_AND_SYSTEM,
  'kept.current_owner_account_id()': APP_ONLY,
  'kept.current_user_managed()': APP_ONLY,
  'kept.current_user_id()': APP_AND_SYSTEM,
  'kept.currencies_in_use()': APP_ONLY,
  'kept.customise_type(uuid,uuid)': APP_ONLY,
  'kept.delete_location(uuid)': APP_ONLY,
  'kept.deleted_locations()': APP_ONLY,
  'kept.ensure_account(text,text,text)': APP_AND_SYSTEM,
  'kept.ensure_audit_partitions(integer)': SYSTEM_ONLY,
  'kept.fellow_member_ids()': APP_ONLY,
  'kept.field_for_key(uuid,text)': OWNER_ONLY,
  'kept.guard_attachment_file()': OWNER_ONLY,
  'kept.guard_field_secret()': OWNER_ONLY,
  'kept.guard_inventory_id()': OWNER_ONLY,
  'kept.guard_audit_event()': OWNER_ONLY,
  'kept.guard_currency_enabled()': OWNER_ONLY,
  'kept.guard_meter()': OWNER_ONLY,
  'kept.guard_person_member()': OWNER_ONLY,
  'kept.guard_purchase_line_link()': OWNER_ONLY,
  'kept.guard_purchase_vendor()': OWNER_ONLY,
  'kept.guard_secret_field()': OWNER_ONLY,
  'kept.guard_template_location()': OWNER_ONLY,
  'kept.guard_template_type()': OWNER_ONLY,
  'kept.guard_thing_custom()': OWNER_ONLY,
  'kept.guard_thing_quantity()': OWNER_ONLY,
  'kept.guard_thing_refs()': OWNER_ONLY,
  'kept.guard_thing_tags()': OWNER_ONLY,
  'kept.guard_type()': OWNER_ONLY,
  'kept.guard_type_field()': OWNER_ONLY,
  'kept.guard_type_keys()': OWNER_ONLY,
  'kept.guard_unplaced()': OWNER_ONLY,
  'kept.instance_admin_recipients()': SYSTEM_ONLY,
  'kept.instance_has_admin()': SYSTEM_ONLY,
  'kept.invite_preview(text)': APP_ONLY,
  'kept.is_instance_admin()': APP_ONLY,
  'kept.lock_partition(text)': OWNER_ONLY,
  'kept.mail_locale(text)': SYSTEM_ONLY,
  'kept.managed_reset_location(uuid)': APP_ONLY,
  'kept.map_registry(text,uuid,uuid)': OWNER_ONLY,
  'kept.map_type(uuid,uuid)': OWNER_ONLY,
  'kept.max_member_expiry(uuid)': APP_ONLY,
  'kept.merge_places(uuid,uuid)': APP_ONLY,
  'kept.merge_registry(text,uuid,uuid)': APP_ONLY,
  'kept.move_things(uuid[],uuid,uuid,uuid)': APP_ONLY,
  'kept.near_thing_names(text,text[],text[],uuid)': APP_ONLY,
  'kept.new_member_notice(uuid,uuid)': SYSTEM_ONLY,
  'kept.owns_location(uuid)': APP_ONLY,
  'kept.path_of(uuid,uuid)': APP_ONLY,
  'kept.person_contact_visible(uuid)': APP_ONLY,
  'kept.person_contact_writable(uuid)': APP_ONLY,
  'kept.person_use_locations(uuid)': OWNER_ONLY,
  'kept.prune_stale_rows()': SYSTEM_ONLY,
  'kept.purge_deleted_locations(integer)': SYSTEM_ONLY,
  'kept.purge_expired_reports(integer)': SYSTEM_ONLY,
  'kept.purge_orphan_files(timestamp with time zone,integer)': SYSTEM_ONLY,
  'kept.purchase_lines_used_elsewhere(uuid,uuid[])': APP_ONLY,
  'kept.purge_trash(timestamp with time zone,integer)': SYSTEM_ONLY,
  'kept.recovery_kit_acknowledged()': APP_ONLY,
  'kept.refresh_thing_doc()': OWNER_ONLY,
  'kept.refresh_thing_cover()': OWNER_ONLY,
  'kept.registry_use_locations(text,uuid)': APP_ONLY,
  'kept.reindex_location(uuid)': SYSTEM_ONLY,
  'kept.rekey_email_invite(uuid,text)': SYSTEM_ONLY,
  'kept.remap_custom_refs(jsonb,uuid,uuid,uuid)': OWNER_ONLY,
  'kept.replace_custom_ref(jsonb,uuid,uuid)': OWNER_ONLY,
  'kept.resolved_keys(uuid)': OWNER_ONLY,
  'kept.restore_location(uuid)': APP_ONLY,
  'kept.retire_orphan_code()': OWNER_ONLY,
  'kept.search_text(text)': APP_AND_SYSTEM,
  'kept.search_file_ids(tsquery,uuid)': APP_ONLY,
  'kept.search_thing_ids(tsquery,tsquery,text,uuid)': APP_ONLY,
  'kept.secret_fields_set(uuid,uuid)': APP_ONLY,
  'kept.secret_keys(uuid)': OWNER_ONLY,
  'kept.set_location_require_2fa(uuid,boolean)': APP_ONLY,
  'kept.set_location_successor(uuid,uuid)': APP_ONLY,
  'kept.split_custom(jsonb,uuid)': OWNER_ONLY,
  'kept.stamp_change_xid()': OWNER_ONLY,
  'kept.stamp_request_user()': OWNER_ONLY,
  'kept.stamp_storage_key()': OWNER_ONLY,
  'kept.strip_prefixes(text)': APP_AND_SYSTEM,
  'kept.supersede_secret()': OWNER_ONLY,
  'kept.thing_cache()': OWNER_ONLY,
  'kept.thing_purchase(uuid)': APP_ONLY,
  'kept.thing_receipt_file(uuid,uuid)': APP_ONLY,
  'kept.thing_receipts(uuid)': APP_ONLY,
  'kept.thing_search_doc(things)': APP_ONLY,
  'kept.touch_row()': APP_AND_SYSTEM,
  'kept.touch_thing_meters()': OWNER_ONLY,
  'kept.type_capabilities(uuid)': APP_AND_SYSTEM,
  'kept.type_chain(uuid)': APP_ONLY,
  'kept.type_impact(uuid)': APP_ONLY,
  'kept.unreferenced_storage_keys(text[])': SYSTEM_ONLY,
  'kept.visible_account_ids()': APP_ONLY,
  'kept.visible_location_ids()': APP_ONLY,
  'kept.writable_account_ids()': APP_ONLY,
  'kept.writable_location_ids()': APP_ONLY,
  // Step 3, T7 (0042): labels, blank claims and duplicate merges.
  'kept.claim_blank_code(character,uuid,uuid)': APP_ONLY,
  'kept.guard_blank_cap()': OWNER_ONLY,
  'kept.merge_things(uuid,uuid)': APP_ONLY,
  'kept.set_file_display(uuid,jsonb)': APP_ONLY,
  // Step 3, T17a (0046): own codes' numbering, and legacy-code removals for phones.
  'kept.next_own_code(uuid)': APP_ONLY,
  'kept.number_new_thing()': OWNER_ONLY,
  'kept.tombstone_legacy_code()': OWNER_ONLY,
  'kept.clear_code_tombstone_on_arrival()': OWNER_ONLY,
  // Step 3, T9 (0043): a cap's use for its readers, and the cap and key-rejected notices.
  'kept.ai_cap_usage(uuid[])': APP_ONLY,
  'kept.ai_notice_cap(uuid)': SYSTEM_ONLY,
  'kept.ai_notice_provider(uuid)': SYSTEM_ONLY,
  'kept.ai_notice_recipients(uuid)': SYSTEM_ONLY,
  // Step 3, T6 (0040): AI providers, caps, pacing and the call ledger.
  'kept.ai_breaker_state(uuid)': APP_AND_SYSTEM,
  'kept.ai_bucket_rows(text,jsonb)': OWNER_ONLY,
  'kept.ai_buckets(jsonb)': OWNER_ONLY,
  'kept.ai_budget_writable(ai_budgets)': OWNER_ONLY,
  'kept.ai_caller_ok()': OWNER_ONLY,
  'kept.ai_cap_clear(uuid)': APP_ONLY,
  'kept.ai_cap_set(jsonb)': APP_ONLY,
  'kept.ai_cap_target(jsonb)': OWNER_ONLY,
  'kept.ai_cascade(uuid,uuid,text)': OWNER_ONLY,
  'kept.ai_clear_trip(uuid)': APP_ONLY,
  'kept.ai_cost_add(text,date,text,numeric)': OWNER_ONLY,
  'kept.ai_ensure_brand(uuid,text)': APP_ONLY,
  'kept.ai_insert_call(jsonb,jsonb,text,jsonb)': OWNER_ONLY,
  'kept.ai_instance_calls(jsonb,text)': APP_ONLY,
  'kept.ai_key_admit(uuid,integer,text,integer)': APP_AND_SYSTEM,
  'kept.ai_key_release(uuid,integer,text)': APP_AND_SYSTEM,
  'kept.ai_observe(uuid,jsonb,jsonb)': APP_AND_SYSTEM,
  'kept.ai_pause(jsonb)': APP_ONLY,
  'kept.ai_payer_reachable(jsonb)': OWNER_ONLY,
  'kept.ai_price_remove(text,text)': APP_ONLY,
  'kept.ai_price_set(jsonb)': APP_ONLY,
  'kept.ai_provider_for(uuid,text)': APP_ONLY,
  'kept.ai_provider_managed(uuid)': OWNER_ONLY,
  'kept.ai_provider_reachable(uuid)': OWNER_ONLY,
  'kept.ai_provider_resolved(uuid)': APP_ONLY,
  'kept.ai_provider_secret(uuid,text)': APP_ONLY,
  'kept.ai_recost_unknown(text,text,timestamp with time zone)': APP_ONLY,
  'kept.ai_reserve(jsonb)': APP_AND_SYSTEM,
  'kept.ai_resume(uuid,jsonb)': APP_ONLY,
  'kept.ai_rollover()': SYSTEM_ONLY,
  'kept.ai_rollup_and_drop(integer)': SYSTEM_ONLY,
  'kept.ai_row_bucket(ai_budgets)': OWNER_ONLY,
  'kept.ai_settle(jsonb,jsonb,text,jsonb)': APP_AND_SYSTEM,
  'kept.ai_spent(text,text)': OWNER_ONLY,
  'kept.ai_status(uuid)': APP_ONLY,
  'kept.ai_tokens_add(text,bigint,integer)': OWNER_ONLY,
  'kept.ai_trip(uuid,timestamp with time zone,text)': APP_AND_SYSTEM,
  'kept.ai_usage(text,uuid,timestamp with time zone,timestamp with time zone,text)': APP_ONLY,
  'kept.ai_used(text,text)': OWNER_ONLY,
  'kept.ai_window_start(text)': OWNER_ONLY,
  'kept.create_llm_partition(date)': OWNER_ONLY,
  'kept.ensure_llm_partitions(integer)': SYSTEM_ONLY,
  'kept.guard_ai_budget_location()': OWNER_ONLY,
  'kept.llm_default_partition_rows()': SYSTEM_ONLY,
  'kept.prune_ai_windows(timestamp with time zone)': SYSTEM_ONLY,
  // Step 4, T4 (0049): export runs' doors, and the AI money caps through exchange rates.
  'kept.export_run_mine(export_runs)': OWNER_ONLY,
  'kept.export_run_claim(uuid)': APP_AND_SYSTEM,
  'kept.export_run_progress(uuid,integer,integer)': APP_AND_SYSTEM,
  'kept.export_run_finish(uuid,bigint,text,text,text)': APP_AND_SYSTEM,
  'kept.export_running(uuid)': APP_ONLY,
  // UI review L3 (0105): the names of tokens seen acting.
  'kept.token_actor_names(uuid[])': APP_ONLY,
  // Step 7 (0104): low stock's day, kept by triggers.
  'kept.stock_rule_low_since()': OWNER_ONLY,
  'kept.stock_quantity_changed()': OWNER_ONLY,
  'kept.export_download(text)': SYSTEM_ONLY,
  'kept.purge_expired_exports(integer)': SYSTEM_ONLY,
  'kept.fx_rate(uuid,text,text,date)': OWNER_ONLY,
  'kept.ai_bucket_account(text)': OWNER_ONLY,
  'kept.ai_convert(numeric,text,text,text)': OWNER_ONLY,
  'kept.ai_spent_uncounted(text,text)': OWNER_ONLY,
  // Step 4, T5 (0051): household records' guards, the state bump, a service's lines.
  'kept.guard_household_refs()': OWNER_ONLY,
  'kept.guard_claim_transition()': OWNER_ONLY,
  'kept.guard_warranty_quantity()': OWNER_ONLY,
  'kept.touch_thing_state()': OWNER_ONLY,
  'kept.service_record_changeable(uuid)': APP_ONLY,
  // Step 4, T6 (0053): the schedule anchor, module state in SQL and the agenda's twins.
  'kept.schedule_base()': OWNER_ONLY,
  'kept.recompute_schedule_anchor(uuid)': OWNER_ONLY,
  'kept.schedule_completion_changed()': OWNER_ONLY,
  'kept.service_record_anchor_changed()': OWNER_ONLY,
  'kept.schedule_base_changed()': OWNER_ONLY,
  'kept.module_enabled(uuid,text)': APP_AND_SYSTEM,
  'kept.module_on(uuid,text)': APP_AND_SYSTEM,
  'kept.schedule_point(integer,numeric,date,date,numeric,date,numeric,boolean,integer,numeric,date,numeric)':
    APP_AND_SYSTEM,
  'kept.meter_latest(uuid)': APP_AND_SYSTEM,
  'kept.schedule_next(uuid,date)': APP_AND_SYSTEM,
  // Step 4, T7 (0055): the notify caps, the calendar feed's door; T19's code move and past
  // membership.
  'kept.guard_notify_caps()': OWNER_ONLY,
  'kept.calendar_feed_user(text)': SYSTEM_ONLY,
  'kept.touch_code_move()': OWNER_ONLY,
  'kept.was_member_of(uuid)': APP_ONLY,
  // Phase B's gaps (0056): undo keeps who made a row; merged parts.
  'kept.undo_event()': OWNER_ONLY,
  'kept.undo_creator(uuid,uuid)': APP_ONLY,
  'kept.undo_holds_file(uuid,uuid)': APP_ONLY,
  'kept.undo_keep_creator()': OWNER_ONLY,
  'kept.guard_thing_merge()': OWNER_ONLY,
  'kept.keep_merged_loans()': OWNER_ONLY,
  // The AI monthly summary's totals (0059).
  'kept.ai_month_summaries(date)': SYSTEM_ONLY,
  // Step 5 (0061): readings reach the snapshot.
  'kept.touch_reading_meters()': OWNER_ONLY,
  // Step 5 (0063): a service draft is confirmed one way.
  'kept.guard_service_review_state()': OWNER_ONLY,
  // Step 5 (0065): a fill's reading is its own vehicle's; a vehicle report follows its car.
  'kept.guard_fuel_reading()': OWNER_ONLY,
  'kept.report_run_follows_thing()': OWNER_ONLY,
  // Step 5 (0066): the usage estimate, estimated due dates and vehicle types.
  'kept.meter_estimate(uuid,timestamp with time zone)': APP_AND_SYSTEM,
  'kept.meter_eta(uuid,numeric,timestamp with time zone)': APP_AND_SYSTEM,
  'kept.meter_eta_at(uuid,numeric,timestamp with time zone)': APP_AND_SYSTEM,
  'kept.schedule_due(schedules,date,timestamp with time zone)': APP_AND_SYSTEM,
  'kept.is_vehicle_type(uuid)': APP_AND_SYSTEM,
  // Step 6 (0070): the token principal, its doors, and tokens dying with access.
  'kept.current_token_id()': APP_AND_SYSTEM,
  'kept.token_location_ids(boolean)': OWNER_ONLY,
  'kept.guard_token_revoked()': OWNER_ONLY,
  'kept.guard_token_location()': OWNER_ONLY,
  'kept.token_last_location()': OWNER_ONLY,
  'kept.token_verify(text,text)': APP_ONLY,
  'kept.token_oauth_for(uuid,text)': APP_ONLY,
  'kept.token_oauth_grant(uuid,text,text,uuid[],text)': APP_ONLY,
  'kept.token_rate_hit(uuid,text,integer)': APP_ONLY,
  'kept.revoke_tokens_in(uuid,uuid,text)': OWNER_ONLY,
  'kept.revoke_tokens_for(uuid,uuid,text)': APP_AND_SYSTEM,
  'kept.membership_access_ended()': OWNER_ONLY,
  // Step 5 (0074): an extraction follows its photo onto a new attachment.
  'kept.guard_extraction_attachment()': OWNER_ONLY,
  // Step 6 (0073): the assistant's retention, search text and redaction.
  'kept.assistant_expiry()': OWNER_ONLY,
  'kept.assistant_thread_expiry()': OWNER_ONLY,
  'kept.assistant_turn_bumps_thread()': OWNER_ONLY,
  'kept.assistant_thread_tsv(uuid,text)': OWNER_ONLY,
  'kept.assistant_message_tsv()': OWNER_ONLY,
  'kept.assistant_title_tsv()': OWNER_ONLY,
  'kept.prune_assistant(timestamp with time zone)': SYSTEM_ONLY,
  'kept.redact_assistant_in(uuid,uuid)': OWNER_ONLY,
  'kept.redact_assistant_for(uuid,uuid)': APP_AND_SYSTEM,
  // Step 6 (0076): semantic search's text, doors, status and background payer.
  'kept.embedding_moved()': OWNER_ONLY,
  'kept.embedding_text_of(text,text[],text,text,text,text,text[],text,text[])': OWNER_ONLY,
  'kept.embedding_text(things)': OWNER_ONLY,
  'kept.embedding_backlog(uuid,text,integer)': APP_AND_SYSTEM,
  'kept.embedding_store(uuid,text,jsonb)': APP_AND_SYSTEM,
  'kept.semantic_thing_ids(text,vector,uuid,integer)': APP_ONLY,
  'kept.embedding_status_instance()': APP_ONLY,
  // (0099) The backfill's mark (kept_system's alone since S4) and live locations; the editor's
  // job's one-thing backlog row.
  'kept.embedding_mark(uuid,text,text,integer,text,timestamp with time zone)': SYSTEM_ONLY,
  'kept.embedding_backfill_locations()': SYSTEM_ONLY,
  'kept.embedding_backlog_thing(uuid,text)': APP_ONLY,
  'kept.ai_provider_for_system(uuid,text)': SYSTEM_ONLY,
  // Step 6 (0078): webhooks' secret, fan-out check, and D180's switch-off.
  'kept.webhook_secret(uuid)': SYSTEM_ONLY,
  'kept.webhooks_listening(uuid,text)': APP_ONLY,
  'kept.disable_webhooks_in(uuid,uuid)': OWNER_ONLY,
  'kept.disable_webhooks_for(uuid,uuid)': APP_AND_SYSTEM,
  // Step 7 (0080): an archive import's target, the prune-imports doors, and D180's end of a
  // former admin's unfinished exports and imports.
  'kept.set_import_target(uuid,uuid)': APP_ONLY,
  'kept.stale_import_runs(timestamp with time zone,integer)': SYSTEM_ONLY,
  'kept.clear_import_run(uuid)': SYSTEM_ONLY,
  'kept.end_portability_runs_in(uuid,uuid)': OWNER_ONLY,
  // Step 7 (0083): a running Kept import's history and label codes, and their owner-only checks.
  'kept.import_history(uuid,jsonb)': APP_ONLY,
  'kept.adopt_short_code(uuid,character,text,uuid,uuid)': APP_ONLY,
  'kept.import_run_mine(uuid)': OWNER_ONLY,
  'kept.audit_change_ok(jsonb)': OWNER_ONLY,
  // Step 7 (0085): the stock-rule guard, and field conversion's doors and owner-only helpers.
  'kept.guard_stock_rule()': OWNER_ONLY,
  'kept.field_conversion_preview(uuid,jsonb)': APP_ONLY,
  'kept.field_conversion_rows(uuid,uuid,integer)': APP_ONLY,
  'kept.apply_field_conversion(uuid,jsonb,jsonb,boolean)': APP_ONLY,
  'kept.field_convert_field(uuid)': OWNER_ONLY,
  'kept.field_convert_mode(type_fields,jsonb,boolean)': OWNER_ONLY,
  'kept.field_values(type_fields)': OWNER_ONLY,
  'kept.field_value_converts(jsonb,jsonb)': OWNER_ONLY,
};

let dbName: string;
let ownerUrl: string;

async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeEach(async () => {
  dbName = `kept_migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await withSuperuser(async (client) => {
    await client.query(`CREATE DATABASE ${dbName} OWNER kept_owner`);
  });
  ownerUrl = `postgres://kept_owner:kept_owner@localhost:5452/${dbName}`;
});

afterEach(async () => {
  await withSuperuser(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
  });
});

describe('runMigrations', () => {
  it('creates kept_meta.migrations and kept.current_user_id on an empty database', async () => {
    await runMigrations(ownerUrl);

    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const migrations = await client.query(`SELECT to_regclass('kept_meta.migrations') AS reg`);
      expect(migrations.rows[0].reg).toBe('kept_meta.migrations');

      const fn = await client.query(`SELECT to_regprocedure('kept.current_user_id()') AS reg`);
      expect(fn.rows[0].reg).toBe('kept.current_user_id()');

      const rowCountRes = await client.query('SELECT count(*)::int AS n FROM kept_meta.migrations');
      expect(rowCountRes.rows[0].n).toBe(MIGRATION_COUNT);
    } finally {
      await client.end();
    }
  });

  it('serialises two concurrent callers behind the advisory lock', async () => {
    await Promise.all([runMigrations(ownerUrl), runMigrations(ownerUrl)]);

    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const rowCountRes = await client.query('SELECT count(*)::int AS n FROM kept_meta.migrations');
      expect(rowCountRes.rows[0].n).toBe(MIGRATION_COUNT);
    } finally {
      await client.end();
    }
  });

  it('installs pg-boss at the version the package expects, idempotently', async () => {
    await runMigrations(ownerUrl);
    await runMigrations(ownerUrl);

    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const res = await client.query('SELECT version FROM pgboss.version');
      expect(res.rows).toHaveLength(1);
      expect(Number(res.rows[0].version)).toBe(pgBossSchemaVersion());
    } finally {
      await client.end();
    }
  });

  it('kept.current_user_id() returns null when app.user_id is unset', async () => {
    await runMigrations(ownerUrl);

    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const res = await client.query('SELECT kept.current_user_id() AS id');
      expect(res.rows[0].id).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('gives up with migrate_lock_timeout when another migrator holds the lock too long', async () => {
    const holder = new pg.Client({ connectionString: ownerUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [0x6b657074]);
      const started = Date.now();
      const err = await runMigrations(ownerUrl, { lockTimeoutMs: 400 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrateError);
      expect(err).toMatchObject({ code: 'migrate_lock_timeout' });
      expect(Date.now() - started).toBeLessThan(5000);

      // Nothing ran: the holder is still the only migrator.
      const reg = await holder.query(`SELECT to_regclass('kept_meta.migrations') AS reg`);
      expect(reg.rows[0].reg).toBeNull();
    } finally {
      await holder.end();
    }
  });

  it('waits for the lock rather than failing when it is released in time', async () => {
    const holder = new pg.Client({ connectionString: ownerUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [0x6b657074]);
    const release = setTimeout(() => void holder.end(), 300);
    try {
      await runMigrations(ownerUrl, { lockTimeoutMs: 10_000 });
    } finally {
      clearTimeout(release);
      await holder.end().catch(() => {});
    }
  });
});

describe('privileges set by the migrations', () => {
  beforeEach(async () => {
    await runMigrations(ownerUrl);
  });

  async function asOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('revokes schema public from PUBLIC and grants USAGE to kept_app and kept_system only', async () => {
    await asOwner(async (client) => {
      const publicGrants = await client.query(
        `SELECT count(*)::int AS n FROM pg_namespace n, aclexplode(n.nspacl) a
         WHERE n.nspname = 'public' AND a.grantee = 0`,
      );
      expect(publicGrants.rows[0].n).toBe(0);

      const usage = await client.query<{ role: string; usage: boolean; create: boolean }>(
        `SELECT r AS role, has_schema_privilege(r, 'public', 'USAGE') AS usage,
                has_schema_privilege(r, 'public', 'CREATE') AS create
         FROM unnest(ARRAY['kept_app', 'kept_system', 'kept_auth']) AS r ORDER BY r`,
      );
      expect(usage.rows).toEqual([
        { role: 'kept_app', usage: true, create: false },
        { role: 'kept_auth', usage: false, create: false },
        { role: 'kept_system', usage: true, create: false },
      ]);
    });
  });

  it('grants EXECUTE on kept.* functions exactly as the inventory says; never kept_auth', async () => {
    await asOwner(async (client) => {
      const { rows } = await client.query<{
        fn: string;
        app: boolean;
        sys: boolean;
        auth: boolean;
      }>(
        `SELECT p.oid::regprocedure::text AS fn,
                has_function_privilege('kept_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('kept_system', p.oid, 'EXECUTE') AS sys,
                has_function_privilege('kept_auth', p.oid, 'EXECUTE') AS auth
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'kept' ORDER BY 1`,
      );
      const actual = Object.fromEntries(
        rows.map((r) => [
          r.fn,
          [...(r.app ? ['kept_app'] : []), ...(r.sys ? ['kept_system'] : [])],
        ]),
      );
      // A new function must be added here, with the roles it is meant for.
      expect(actual).toEqual(KEPT_FUNCTION_EXECUTE);
      expect(rows.filter((r) => r.auth).map((r) => r.fn)).toEqual([]);
    });
  });

  it('keeps functions kept_owner creates later from PUBLIC, in any schema', async () => {
    await asOwner(async (client) => {
      await client.query('CREATE SCHEMA later');
      await client.query(
        'CREATE FUNCTION later.probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      );
      await client.query(
        'CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      );
      const { rows } = await client.query(
        `SELECT has_function_privilege('kept_auth', 'later.probe()', 'EXECUTE') AS later,
                has_function_privilege('kept_auth', 'public.probe()', 'EXECUTE') AS public`,
      );
      expect(rows[0]).toEqual({ later: false, public: false });
    });
  });
});
