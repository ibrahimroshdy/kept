import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type Scope, withScope, withSystem } from '../src/db/scope.js';
import { notFound, toErrorReply } from '../src/http/errors.js';
import { testDb } from './db.js';
import { fillAssistant } from './leak-assistant.js';
import { fillCapture } from './leak-capture.js';
import { fillHousehold } from './leak-household.js';
import { fillInventory } from './leak-inventory.js';
import { fillOperations } from './leak-operations.js';
import { fillPortability } from './leak-portability.js';
import { fillVehicles } from './leak-vehicles.js';
import { addMember, asOwner, ownerTx, seedTenant, seedUser, type Tenant } from './tenancy.js';

// The schema-wide leak test (engineering spec §1.1, §7.1, §7.2; D178, L28, L30).
//
// Everything below is generated from the catalogue (pg_class, pg_policies, information_schema),
// so a table added later is covered without editing this file, and fails here until it has RLS,
// policies, a scope, and fixture rows. The explicit lists are the deliberate exceptions; adding
// to one is a decision a reviewer should see.

/** Tables kept_system may read and write across tenants (0006 `system_all`, §7.1). */
const SYSTEM_TABLES = [
  'admin_alerts',
  'audit_events',
  'instance_settings',
  'memberships',
  'owner_accounts',
  'user_profiles',
].sort();

/** Tables the reminder jobs write across tenants (0055, step-4 T7): the ledger, the centre's
 * rows, and the channels, devices and preferences they send by; and the webhook jobs' (0078,
 * step-6 T7): the hooks they send to (read, and marked failing) and the deliveries they record;
 * and the worker's boot guard's (0091, step-8 T8): the release history it reads and stamps.
 * Each kept_system policy names its job in a comment. */
const SYSTEM_JOB_TABLES = [
  'notification_channels',
  'notification_digests',
  'notification_preferences',
  'notifications',
  'push_subscriptions',
  'release_history',
  'reminder_deliveries',
  'reminder_occurrences',
  'webhook_deliveries',
  'webhooks',
].sort();

/** Tables kept_system only reads across tenants (SELECT-only `system_select` policies, each
 * commented with the job it serves): the reminder scan reads every location's agenda (0053,
 * step-4 T6), the estimate's offsets and a document's vehicle type (0066, step-5 T7), and the
 * price table the embeddings backfill costs its calls by (0099), and the keep-at-least rules the
 * scan's low-stock branch reads (0104). It changes and writes nothing in them. */
const SYSTEM_READ_TABLES = [
  'ai_model_prices',
  'expiring_documents',
  'loans',
  'location_modules',
  'locations',
  'meter_events',
  'meter_readings',
  'meters',
  'people',
  'places',
  'schedules',
  'service_completions',
  'service_records',
  'stock_rules',
  'things',
  'types',
  'user_hidden_modules',
  'warranties',
].sort();

/** Tables with no tenant scope column, and why. Anything else must carry location_id,
 * owner_account_id or user_id (L15), or be one of IDENTITY_SCOPE. */
const UNSCOPED: Record<string, 'reference' | 'instance'> = {
  currencies: 'reference', // readable by every signed-in request (and nothing else)
  instance_settings: 'instance', // instance admins only (§7.14)
  admin_alerts: 'instance', // instance admins read; kept_system writes (task 25, 0011)
  ai_model_prices: 'reference', // every signed-in request reads the price table (0040, D206)
  backup_runs: 'instance', // instance admins read; only kept_owner writes (0091, step 8)
  release_history: 'instance', // instance admins read; the boot guard stamps it (0091, step 8)
};

/** Tables no runtime role may touch at all, and why: no grant, no kept_app policy; only the
 * SECURITY DEFINER doors listed in FUNCTIONS read and write them. The embedding tables carry a
 * location_id, but no runtime role reaches them, so the scope walks leave them out (targets());
 * the checks below hold them to no privilege at all. */
const DEFINER_ONLY_TABLES: Record<string, string> = {
  ai_usage_windows: 'counters: only the kept.ai_* doors touch them (0040)',
  ai_cost_windows: 'counters: only the kept.ai_* doors touch them (0040)',
  ai_leases: 'counters: only the kept.ai_* doors touch them (0040)',
  ai_breakers: "counters: a key's breaker, only through the kept.ai_* doors (0040)",
  ai_provider_limits: "counters: a provider's rate-limit window, only through the doors (0040)",
  token_rate_windows: 'per-token counters: only kept.token_rate_hit touches them (0070)',
  thing_embeddings:
    'vectors are derived from things; only the kept.embedding_* and kept.semantic_* doors touch them (0076)',
  embedding_state: "a location's index progress; only the kept.embedding_* doors touch it (0076)",
};

/** Tables whose own id is the scope. */
const IDENTITY_SCOPE: Record<string, 'location' | 'account'> = {
  locations: 'location',
  owner_accounts: 'account',
};

/** Scope columns found by name. */
const SCOPE_COLUMNS = { location_id: 'location', owner_account_id: 'account', user_id: 'user' };

/** Tables where a `user_id` column is a reference to someone, not the row's scope (e.g. a person
 * record linked to a user in another account). None yet. */
const USER_ID_NOT_SCOPE = new Set<string>();

/** kept_app / kept_system privileges in schema auth, each granted on purpose. Task 18:
 * kept_system SELECT on auth.user, columns id and created_at only (migration 0007), for the
 * repair-orphans job. Task 24's prune of auth.sign_in_failures and auth.session_mfa goes through
 * kept.prune_stale_rows() (0011) instead of a grant, so nothing is added here. Anything else
 * there is a leak. */
const AUTH_PRIVILEGES: { role: string; table: string; privilege: string }[] = [
  { role: 'kept_system', table: 'user', privilege: 'SELECT' },
];
const AUTH_SCHEMA_USAGE: string[] = ['kept_system'];

const RUNTIME = ['kept_app', 'kept_system'] as const;
const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

/** Every function kept_app or kept_system may EXECUTE, and every SECURITY DEFINER function, in
 * any schema but pg_catalog, outside extensions (review #6). A definer function runs as
 * kept_owner, past every policy: each is a deliberate door, listed with who may open it. Adding
 * a line here is a decision a reviewer should see; migrate.test.ts holds the same for kept.*,
 * including the functions nobody but kept_owner runs. */
const APP = ['kept_app'];
const SYS = ['kept_system'];
const BOTH = ['kept_app', 'kept_system'];
const NOBODY: string[] = [];
const FUNCTIONS: Record<string, { roles: string[]; definer: boolean }> = {
  // Scope readers and row bookkeeping (0000): invoker, harmless.
  'kept.current_mfa()': { roles: BOTH, definer: false },
  'kept.current_user_id()': { roles: BOTH, definer: false },
  'kept.touch_row()': { roles: BOTH, definer: false },
  // RLS membership functions (0006 §1): read memberships past their own policies.
  'kept.admin_location_ids()': { roles: APP, definer: true },
  'kept.current_owner_account_id()': { roles: APP, definer: true },
  'kept.fellow_member_ids()': { roles: APP, definer: true },
  'kept.is_instance_admin()': { roles: APP, definer: true },
  'kept.owns_location(uuid)': { roles: APP, definer: true },
  'kept.visible_location_ids()': { roles: APP, definer: true },
  'kept.writable_location_ids()': { roles: APP, definer: true },
  // Paths past the policies (0006 §5): each checks its caller itself.
  'kept.accept_invite(text,text)': { roles: APP, definer: true },
  // (0010, security review of tasks 19–21) A sign-up's hold on an invite; managed-account reset
  // authority (D197); the D180 expiry cap and the D47 location-insert check the policies use.
  'kept.claim_invite(text,text)': { roles: APP, definer: true },
  'kept.current_user_managed()': { roles: APP, definer: true },
  'kept.managed_reset_location(uuid)': { roles: APP, definer: true },
  'kept.max_member_expiry(uuid)': { roles: APP, definer: true },
  // (0009) An instance admin's user list: role counts only.
  'kept.admin_user_summaries(uuid[])': { roles: APP, definer: true },
  'kept.add_managed_member(uuid,uuid,text,timestamp with time zone)': { roles: APP, definer: true },
  'kept.create_managed_profile(uuid,text)': { roles: APP, definer: true },
  'kept.delete_location(uuid)': { roles: APP, definer: true },
  'kept.deleted_locations()': { roles: APP, definer: true },
  'kept.invite_preview(text)': { roles: APP, definer: true },
  'kept.restore_location(uuid)': { roles: APP, definer: true },
  'kept.set_location_require_2fa(uuid,boolean)': { roles: APP, definer: true },
  'kept.set_location_successor(uuid,uuid)': { roles: APP, definer: true },
  // Maintenance: next months' audit partitions (task 24).
  'kept.ensure_audit_partitions(integer)': { roles: SYS, definer: true },
  // First run (0009): whether setup is done, and the first instance admin.
  'kept.claim_first_instance_admin(uuid)': { roles: SYS, definer: true },
  'kept.instance_has_admin()': { roles: SYS, definer: true },
  // (0010) The email-invite mail job makes the token it mails.
  'kept.rekey_email_invite(uuid,text)': { roles: SYS, definer: true },
  // (0011) The system jobs' and the mail transport's doors (tasks 24–25): the nightly prune, the
  // default-partition check, alert recipients, a mail's language, the owner's new-member notice.
  'kept.audit_default_partition_rows()': { roles: SYS, definer: true },
  'kept.instance_admin_recipients()': { roles: SYS, definer: true },
  'kept.mail_locale(text)': { roles: SYS, definer: true },
  'kept.new_member_notice(uuid,uuid)': { roles: SYS, definer: true },
  'kept.prune_stale_rows()': { roles: SYS, definer: true },
  // Account creation, step two (0007, task 18): only ever for the scope's own user.
  'kept.ensure_account(text,text,text)': { roles: BOTH, definer: true },
  // The ownership invariant's trigger: must see every membership. Nobody calls it.
  'kept.check_location_owner()': { roles: NOBODY, definer: true },
  // Step 2 (0012): search normalisation, invoker and harmless (requests and the reindex job).
  'kept.normalize(text)': { roles: BOTH, definer: false },
  'kept.search_text(text)': { roles: BOTH, definer: false },
  'kept.strip_prefixes(text)': { roles: BOTH, definer: false },
  // (0012) Account scope for the account registries, and the recovery-kit gate for writers.
  'kept.admin_account_ids()': { roles: APP, definer: true },
  'kept.recovery_kit_acknowledged()': { roles: APP, definer: true },
  'kept.visible_account_ids()': { roles: APP, definer: true },
  'kept.writable_account_ids()': { roles: APP, definer: true },
  // (0014) Registries: contact details (D177); the type chain and its capabilities.
  'kept.person_contact_visible(uuid)': { roles: APP, definer: true },
  'kept.type_capabilities(uuid)': { roles: BOTH, definer: false },
  'kept.type_chain(uuid)': { roles: APP, definer: false },
  // (0016) Things: breadcrumbs and the search document (invoker; the triggers call them).
  'kept.path_of(uuid,uuid)': { roles: APP, definer: false },
  'kept.thing_search_doc(things)': { roles: APP, definer: false },
  // (0018) A thing's purchase and line, even after a move (D115).
  'kept.thing_purchase(uuid)': { roles: APP, definer: true },
  // (0020) Receipts after a move (D115); who may reveal a secret, and which are set (D177). The
  // supersede trigger must see the row a member can't read; nobody calls it.
  'kept.can_reveal_secret(uuid,uuid)': { roles: APP, definer: true },
  'kept.clear_secret(uuid,uuid,text)': { roles: APP, definer: true },
  'kept.secret_fields_set(uuid,uuid)': { roles: APP, definer: true },
  'kept.supersede_secret()': { roles: NOBODY, definer: true },
  // (0031) Things and places share one id namespace (review #35): the deferred trigger must see
  // every tenant's ids. Nobody calls it.
  'kept.guard_inventory_id()': { roles: NOBODY, definer: true },
  'kept.thing_receipt_file(uuid,uuid)': { roles: APP, definer: true },
  'kept.thing_receipts(uuid)': { roles: APP, definer: true },
  // (0021) The inventory's definer paths: moves across locations and accounts, place/container
  // conversions, merges, customising a built-in type and its impact (task 9).
  'kept.convert_container_to_place(uuid,uuid)': { roles: APP, definer: true },
  'kept.convert_place_to_container(uuid,uuid)': { roles: APP, definer: true },
  'kept.customise_type(uuid,uuid)': { roles: APP, definer: true },
  'kept.merge_places(uuid,uuid)': { roles: APP, definer: true },
  'kept.merge_registry(text,uuid,uuid)': { roles: APP, definer: true },
  'kept.move_things(uuid[],uuid,uuid,uuid)': { roles: APP, definer: true },
  'kept.type_impact(uuid)': { roles: APP, definer: true },
  // (0022) kept_system's maintenance doors: the reindex job and the purges (task 10).
  'kept.purge_deleted_locations(integer)': { roles: SYS, definer: true },
  'kept.purge_orphan_files(timestamp with time zone,integer)': { roles: SYS, definer: true },
  'kept.purge_trash(timestamp with time zone,integer)': { roles: SYS, definer: true },
  'kept.reindex_location(uuid)': { roles: SYS, definer: true },
  // (0024, security review of Phase A) Adding contact details past the contacts' own policy
  // (D177); the member link on a person must see memberships the caller can't. Nobody calls the
  // trigger.
  'kept.guard_person_member()': { roles: NOBODY, definer: true },
  'kept.person_contact_writable(uuid)': { roles: APP, definer: true },
  // (0026, task 11) Where a registry row is used across its account: in_use and reindexing.
  'kept.registry_use_locations(text,uuid)': { roles: APP, definer: true },
  // (0027, task 12) Currencies a location uses (instance admins only), and a purchase's lines
  // still used in another location (writers of its location).
  'kept.currencies_in_use()': { roles: APP, definer: true },
  'kept.purchase_lines_used_elsewhere(uuid,uuid[])': { roles: APP, definer: true },
  // (0028) Which storage keys no file or derivative row names any more: "delete original"
  // asks after its commit, so a blob a cross-account copy shares stays (D161).
  'kept.unreferenced_storage_keys(text[])': { roles: SYS, definer: true },
  // (0030, task 24) Text search on its indexes: under RLS `@@` and `%` aren't leakproof, so the
  // match runs past the policy qual and applies the caller's visibility itself; ids and names
  // of visible things only.
  'kept.near_thing_names(text,text[],text[],uuid)': { roles: APP, definer: true },
  'kept.search_thing_ids(tsquery,tsquery,text,uuid)': { roles: APP, definer: true },
  // (0032, task 32) The hourly purge of generated reports past their 24 hours (D201); it
  // returns the run ids whose blobs (`r/<id>.pdf`) the job then deletes.
  'kept.purge_expired_reports(integer)': { roles: SYS, definer: true },
  // (0036, step-3 T4) The cover cache: things.cover_file_id has no UPDATE grant, so the
  // attachments trigger that keeps it writes past the column privileges. Nobody calls it.
  'kept.refresh_thing_cover()': { roles: NOBODY, definer: true },
  'kept.touch_thing_meters()': { roles: NOBODY, definer: true },
  // (0038, T5) Document search on file_text's index (`@@` isn't leakproof, §7.2): file ids the
  // caller could already select, and nothing else.
  'kept.search_file_ids(tsquery,uuid)': { roles: APP, definer: true },
  // (0040, T6) AI providers, caps and the call ledger (D206, §7.15). The guard must see the
  // location's account; nobody calls it.
  'kept.guard_ai_budget_location()': { roles: NOBODY, definer: true },
  // Resolution: the only way to a key (ai/db-keys.ts), and the status line.
  'kept.ai_provider_resolved(uuid)': { roles: APP, definer: true },
  'kept.ai_provider_for(uuid,text)': { roles: APP, definer: true },
  'kept.ai_provider_secret(uuid,text)': { roles: APP, definer: true },
  'kept.ai_status(uuid)': { roles: APP, definer: true },
  // The gate and the pacer, for requests and background jobs alike: the only writers of the
  // ledger and the counters.
  'kept.ai_reserve(jsonb)': { roles: BOTH, definer: true },
  'kept.ai_settle(jsonb,jsonb,text,jsonb)': { roles: BOTH, definer: true },
  'kept.ai_key_admit(uuid,integer,text,integer)': { roles: BOTH, definer: true },
  'kept.ai_key_release(uuid,integer,text)': { roles: BOTH, definer: true },
  'kept.ai_breaker_state(uuid)': { roles: BOTH, definer: true },
  'kept.ai_observe(uuid,jsonb,jsonb)': { roles: BOTH, definer: true },
  'kept.ai_trip(uuid,timestamp with time zone,text)': { roles: BOTH, definer: true },
  'kept.ai_clear_trip(uuid)': { roles: APP, definer: true },
  // Caps, pauses, usage, prices and brands the model proposes.
  'kept.ai_cap_set(jsonb)': { roles: APP, definer: true },
  'kept.ai_cap_clear(uuid)': { roles: APP, definer: true },
  'kept.ai_pause(jsonb)': { roles: APP, definer: true },
  'kept.ai_resume(uuid,jsonb)': { roles: APP, definer: true },
  'kept.ai_usage(text,uuid,timestamp with time zone,timestamp with time zone,text)': {
    roles: APP,
    definer: true,
  },
  'kept.ai_instance_calls(jsonb,text)': { roles: APP, definer: true },
  'kept.ai_price_set(jsonb)': { roles: APP, definer: true },
  'kept.ai_price_remove(text,text)': { roles: APP, definer: true },
  'kept.ai_recost_unknown(text,text,timestamp with time zone)': { roles: APP, definer: true },
  'kept.ai_ensure_brand(uuid,text)': { roles: APP, definer: true },
  // (0043, T9) A cap's month so far, for the cap rows the caller may read.
  'kept.ai_cap_usage(uuid[])': { roles: APP, definer: true },
  // (0042, T7) Claiming a blank label (the server decides, D43/D112) and merging a duplicate
  // (D36): each checks the caller writes the location.
  'kept.claim_blank_code(character,uuid,uuid)': { roles: APP, definer: true },
  'kept.merge_things(uuid,uuid)': { roles: APP, definer: true },
  // (0042, for T13) The phone's display of a photo: files are append-only to kept_app.
  'kept.set_file_display(uuid,jsonb)': { roles: APP, definer: true },
  // (0046, T17a) The next numbered own code (checks the caller writes the location); numbering
  // a new thing; a legacy code's tombstone as it goes and as it comes back.
  'kept.next_own_code(uuid)': { roles: APP, definer: true },
  'kept.number_new_thing()': { roles: NOBODY, definer: true },
  'kept.tombstone_legacy_code()': { roles: NOBODY, definer: true },
  'kept.clear_code_tombstone_on_arrival()': { roles: NOBODY, definer: true },
  // kept_system's: ledger partitions, the default-partition alert, the daily rollover, the
  // monthly rollup and the window prune.
  'kept.ensure_llm_partitions(integer)': { roles: SYS, definer: true },
  'kept.llm_default_partition_rows()': { roles: SYS, definer: true },
  'kept.ai_rollover()': { roles: SYS, definer: true },
  // (0043, T9) The cap and key-rejected notices' view of a cap, its recipients and a key.
  'kept.ai_notice_cap(uuid)': { roles: SYS, definer: true },
  'kept.ai_notice_recipients(uuid)': { roles: SYS, definer: true },
  'kept.ai_notice_provider(uuid)': { roles: SYS, definer: true },
  'kept.ai_rollup_and_drop(integer)': { roles: SYS, definer: true },
  'kept.prune_ai_windows(timestamp with time zone)': { roles: SYS, definer: true },
  // (0049, step-4 T4) Export runs (claim packs, D180): the job's doors are its creator's (a
  // tenant job) or kept_system's; the public link and the purge are kept_system's.
  'kept.export_run_claim(uuid)': { roles: BOTH, definer: true },
  'kept.export_run_progress(uuid,integer,integer)': { roles: BOTH, definer: true },
  'kept.export_run_finish(uuid,bigint,text,text,text)': { roles: BOTH, definer: true },
  // (0104) Low stock: a thing's quantity change keeps its rule's low_since (no grant on the
  // column). Nobody calls it.
  'kept.stock_quantity_changed()': { roles: NOBODY, definer: true },
  // (0101) Whether any Kept export of a location runs: its owners' and admins' only.
  'kept.export_running(uuid)': { roles: APP, definer: true },
  // (0105) The names of tokens seen acting in a location the caller sees (UI review L3).
  'kept.token_actor_names(uuid[])': { roles: APP, definer: true },
  'kept.export_download(text)': { roles: SYS, definer: true },
  'kept.purge_expired_exports(integer)': { roles: SYS, definer: true },
  // (0051, T5) The thing's state bump: things.state_version has no grant. Nobody calls it. And
  // the service-lines policies' check, invoker.
  'kept.touch_thing_state()': { roles: NOBODY, definer: true },
  'kept.service_record_changeable(uuid)': { roles: APP, definer: false },
  // (0053, T6) The schedule anchor: kept up by triggers past the column grants; nobody calls
  // them. Module state, a meter's latest reading and a schedule's next due point: invoker, for
  // requests and the reminder scan alike (they read under the caller's policies).
  'kept.recompute_schedule_anchor(uuid)': { roles: NOBODY, definer: true },
  'kept.schedule_completion_changed()': { roles: NOBODY, definer: true },
  'kept.service_record_anchor_changed()': { roles: NOBODY, definer: true },
  'kept.schedule_base_changed()': { roles: NOBODY, definer: true },
  'kept.module_enabled(uuid,text)': { roles: BOTH, definer: false },
  'kept.module_on(uuid,text)': { roles: BOTH, definer: false },
  'kept.schedule_point(integer,numeric,date,date,numeric,date,numeric,boolean,integer,numeric,date,numeric)':
    {
      roles: BOTH,
      definer: false,
    },
  'kept.meter_latest(uuid)': { roles: BOTH, definer: false },
  'kept.schedule_next(uuid,date)': { roles: BOTH, definer: false },
  // (0055, T7) The public calendar feed's door (D142, D181): kept_system, by token hash. A code
  // moved to another thing bumps the thing it left (T19): nobody calls it. Whether the caller
  // was a member of a location, for sync's location_revoked (T19, D210).
  'kept.calendar_feed_user(text)': { roles: SYS, definer: true },
  'kept.touch_code_move()': { roles: NOBODY, definer: true },
  'kept.was_member_of(uuid)': { roles: APP, definer: true },
  // (0056) Undo keeps who made a row, and links the files its event held: both read only the
  // event `app.undo` names, when the caller may undo it. A merged part's loans outlive it.
  'kept.undo_creator(uuid,uuid)': { roles: APP, definer: true },
  'kept.undo_holds_file(uuid,uuid)': { roles: APP, definer: true },
  'kept.keep_merged_loans()': { roles: NOBODY, definer: true },
  // (0059) The AI monthly summary job's per-person totals, with the address to write to.
  'kept.ai_month_summaries(date)': { roles: SYS, definer: true },
  // (0061, step-5 T4) A reading bumps its thing's meter_version (no column grant), so the
  // snapshot resends the thing with its latest reading. Nobody calls it.
  'kept.touch_reading_meters()': { roles: NOBODY, definer: true },
  // (0066, step-5 T7) The usage estimate, estimated due dates and vehicle types: invokers, so
  // RLS decides what they see (the reminder scan reads through its system_select policies).
  'kept.meter_estimate(uuid,timestamp with time zone)': { roles: BOTH, definer: false },
  'kept.meter_eta(uuid,numeric,timestamp with time zone)': { roles: BOTH, definer: false },
  // (0100) The ETA as a row a caller joins (inlined): invoker, as meter_eta() was.
  'kept.meter_eta_at(uuid,numeric,timestamp with time zone)': { roles: BOTH, definer: false },
  'kept.schedule_due(schedules,date,timestamp with time zone)': { roles: BOTH, definer: false },
  'kept.is_vehicle_type(uuid)': { roles: BOTH, definer: false },
  // (0070, step-6 T4) The token principal: the scope reader (invoker), the doors a request takes
  // before it has a scope (verify, an OAuth grant's lookup, the rate limiter), the consent step's
  // grant, and revocation for the membership routes and jobs. The location guard, the
  // last-location revoke and the membership trigger: nobody calls them.
  'kept.current_token_id()': { roles: BOTH, definer: false },
  'kept.token_verify(text,text)': { roles: APP, definer: true },
  'kept.token_oauth_for(uuid,text)': { roles: APP, definer: true },
  'kept.token_oauth_grant(uuid,text,text,uuid[],text)': { roles: APP, definer: true },
  'kept.token_rate_hit(uuid,text,integer)': { roles: APP, definer: true },
  'kept.revoke_tokens_for(uuid,uuid,text)': { roles: BOTH, definer: true },
  'kept.guard_token_location()': { roles: NOBODY, definer: true },
  'kept.token_last_location()': { roles: NOBODY, definer: true },
  'kept.membership_access_ended()': { roles: NOBODY, definer: true },
  // (0073, step-6 T5) The assistant: retention and the search text are kept by triggers (nobody
  // calls them); the maintenance job prunes; redaction for the membership routes and jobs.
  'kept.assistant_thread_expiry()': { roles: NOBODY, definer: true },
  'kept.assistant_turn_bumps_thread()': { roles: NOBODY, definer: true },
  'kept.assistant_message_tsv()': { roles: NOBODY, definer: true },
  'kept.assistant_title_tsv()': { roles: NOBODY, definer: true },
  'kept.prune_assistant(timestamp with time zone)': { roles: SYS, definer: true },
  'kept.redact_assistant_for(uuid,uuid)': { roles: BOTH, definer: true },
  // (0076, step-6 T6) Semantic search: the backfill's and the editor's job's doors, the only
  // way to a match, the index's status, and the background's payer for embeddings.
  'kept.embedding_backlog(uuid,text,integer)': { roles: BOTH, definer: true },
  'kept.embedding_store(uuid,text,jsonb)': { roles: BOTH, definer: true },
  'kept.semantic_thing_ids(text,vector,uuid,integer)': { roles: APP, definer: true },
  'kept.embedding_status_instance()': { roles: APP, definer: true },
  // (0099) The backfill's mark, kept_system's alone (security review S4), and the live locations
  // it visits; the editor's job's backlog row for its one thing.
  'kept.embedding_mark(uuid,text,text,integer,text,timestamp with time zone)': {
    roles: SYS,
    definer: true,
  },
  'kept.embedding_backfill_locations()': { roles: SYS, definer: true },
  'kept.embedding_backlog_thing(uuid,text)': { roles: APP, definer: true },
  'kept.ai_provider_for_system(uuid,text)': { roles: SYS, definer: true },
  // (0078, step-6 T7) Webhooks: the delivery job's view of a hook with its sealed secret, whether
  // a write should fan out, and turning off a hook whose creator lost the admin role (D180).
  'kept.webhook_secret(uuid)': { roles: SYS, definer: true },
  'kept.webhooks_listening(uuid,text)': { roles: APP, definer: true },
  'kept.disable_webhooks_for(uuid,uuid)': { roles: BOTH, definer: true },
  // (0080, step-7 T4) An archive import's target, set once by its creator; the prune-imports
  // job's view of abandoned runs and the door that clears one.
  'kept.set_import_target(uuid,uuid)': { roles: APP, definer: true },
  'kept.stale_import_runs(timestamp with time zone,integer)': { roles: SYS, definer: true },
  'kept.clear_import_run(uuid)': { roles: SYS, definer: true },
  // (0083, step-7 T5) A running Kept import's carried history and adopted label codes: its
  // creator's, while they administer its location.
  'kept.import_history(uuid,jsonb)': { roles: APP, definer: true },
  'kept.adopt_short_code(uuid,character,text,uuid,uuid)': { roles: APP, definer: true },
  // (0085, step-7 T6) Converting a field to or from secret, or to another kind: the account
  // owner's preview (counts), its values, and the batches it writes.
  'kept.field_conversion_preview(uuid,jsonb)': { roles: APP, definer: true },
  'kept.field_conversion_rows(uuid,uuid,integer)': { roles: APP, definer: true },
  'kept.apply_field_conversion(uuid,jsonb,jsonb,boolean)': { roles: APP, definer: true },
  // pg-boss (jobs/install.ts): kept_app only reads the clock; the worker runs the queue.
  'pgboss.create_queue(text,jsonb)': { roles: SYS, definer: false },
  'pgboss.delete_queue(text)': { roles: SYS, definer: false },
  'pgboss.job_now()': { roles: BOTH, definer: false },
  'pgboss.job_table_format(text,text)': { roles: SYS, definer: false },
  'pgboss.job_table_run(text,text,text)': { roles: SYS, definer: false },
  'pgboss.job_table_run_async(text,integer,text,text,text)': { roles: SYS, definer: false },
};

/** Columns kept_app must never UPDATE, in any table: a row's own id, its primary key, and its
 * scope (review #5). Changing one moves the row to another tenant or makes it another row. */
const KEY_COLUMNS = ['id', ...Object.keys(SCOPE_COLUMNS)];

const db = await testDb();
// Each catalogue-driven test walks every scoped table (three times as many since step 2), with a
// transaction per statement; under a full parallel run that outgrows the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Kind = 'location' | 'account' | 'user';
type Target = { table: string; column: string; kind: Kind };

// ------------------------------------------------------------------------------------------
// Catalogue queries. Functions of a client, so the self-checks below can run them inside an
// owner transaction that creates a bad object and rolls back.
// ------------------------------------------------------------------------------------------

/** Ordinary and partitioned tables in public, without the partitions themselves. */
async function publicTables(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

async function rlsProblems(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ name: string; problem: string }>(
    `WITH t AS (
       SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relispartition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     )
     SELECT relname AS name, 'rls not enabled' AS problem FROM t WHERE NOT relrowsecurity
     UNION ALL
     SELECT relname, 'rls not forced' FROM t WHERE NOT relforcerowsecurity
     UNION ALL
     SELECT relname, 'no owner_all policy' FROM t
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = t.relname AND p.policyname = 'owner_all'
           AND p.cmd = 'ALL' AND p.roles = '{kept_owner}' AND p.qual = 'true'
           AND p.with_check = 'true')
     UNION ALL
     SELECT relname, 'no kept_app policy' FROM t
      WHERE NOT relispartition AND NOT (relname = ANY ($1::text[])) AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = t.relname AND 'kept_app' = ANY (p.roles))
     ORDER BY 1, 2`,
    [Object.keys(DEFINER_ONLY_TABLES)],
  );
  return rows.map((r) => `${r.name}: ${r.problem}`);
}

/** Policies that apply to PUBLIC (every role, including kept_auth and future roles). */
async function publicPolicies(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `SELECT format('%s.%s.%s', schemaname, tablename, policyname) AS name FROM pg_policies
      WHERE 'public' = ANY (roles) ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/** Views that run as their owner (bypassing the caller's RLS, L28), and materialized views,
 * which can't have RLS at all. */
async function viewProblems(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `SELECT format('%s.%s', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND ((c.relkind = 'v'
              AND NOT coalesce(c.reloptions::text[] && ARRAY['security_invoker=true',
                                                             'security_invoker=on',
                                                             'security_invoker=1'], false))
             OR c.relkind = 'm')
      ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/** Every (table, scope column) pair: named columns plus the identity-scoped tables. */
async function targets(c: pg.ClientBase): Promise<Target[]> {
  const tables = new Set(await publicTables(c));
  const { rows } = await c.query<{ table_name: string; column_name: keyof typeof SCOPE_COLUMNS }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = ANY ($1) ORDER BY 1, 2`,
    [Object.keys(SCOPE_COLUMNS)],
  );
  const found: Target[] = rows
    .filter((r) => tables.has(r.table_name) && !(r.table_name in DEFINER_ONLY_TABLES))
    .filter((r) => !(r.column_name === 'user_id' && USER_ID_NOT_SCOPE.has(r.table_name)))
    .map((r) => ({
      table: r.table_name,
      column: r.column_name,
      kind: SCOPE_COLUMNS[r.column_name] as Kind,
    }));
  for (const [table, kind] of Object.entries(IDENTITY_SCOPE)) {
    found.push({ table, column: 'id', kind });
  }
  return found;
}

/** What each runtime role may EXECUTE, and which functions are SECURITY DEFINER. */
async function functionInventory(
  c: pg.ClientBase,
): Promise<Record<string, { roles: string[]; definer: boolean }>> {
  const { rows } = await c.query<{ fn: string; definer: boolean; app: boolean; sys: boolean }>(
    // Spelled out rather than ::regprocedure, which drops the schema of anything in public.
    `SELECT n.nspname || '.' || p.proname || '(' ||
            (SELECT coalesce(string_agg(format_type(t, NULL), ',' ORDER BY o), '')
               FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS args(t, o)) || ')' AS fn,
            p.prosecdef AS definer,
            has_function_privilege('kept_app', p.oid, 'EXECUTE') AS app,
            has_function_privilege('kept_system', p.oid, 'EXECUTE') AS sys
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                           AND d.deptype = 'e')
      ORDER BY 1`,
  );
  return Object.fromEntries(
    rows
      .filter((r) => r.app || r.sys || r.definer)
      .map((r) => [
        r.fn,
        {
          roles: [...(r.app ? ['kept_app'] : []), ...(r.sys ? ['kept_system'] : [])],
          definer: r.definer,
        },
      ]),
  );
}

/** Id, primary-key and scope columns kept_app holds UPDATE on. */
async function updatableKeys(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ col: string }>(
    `SELECT DISTINCT format('%s.%s', c.relname, a.attname) AS col
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND (a.attname = ANY ($1) OR a.attnum = ANY (coalesce(pk.conkey, '{}')))
        AND has_column_privilege('kept_app', c.oid, a.attnum, 'UPDATE')
      ORDER BY 1`,
    [KEY_COLUMNS],
  );
  return rows.map((r) => r.col);
}

// ------------------------------------------------------------------------------------------
// Two tenants, A and B, sharing nothing. B is also an instance admin, so instance rows exist
// under B's user id.
// ------------------------------------------------------------------------------------------

let a: Tenant;
let b: Tenant;
/** A require_2fa tenant, for the no-second-factor actor. */
let g: Tenant;
let viewerOfB: string;
let expiredOfB: string;
let memberOfG: string;
let adminOfA: string;
let allTargets: Target[];

async function fillTenant(t: Tenant, label: string): Promise<void> {
  await ownerTx(db, async (c) => {
    const room = newId();
    await c.query(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)`, [
      room,
      t.locationId,
      `${label} room`,
    ]);
    await c.query(
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'money', true)`,
      [t.locationId],
    );
    await c.query(
      `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'money')`,
      [t.userId, t.locationId],
    );
    await c.query(
      `INSERT INTO public.invites (location_id, role, token_hash, expires_at, created_by)
       VALUES ($1, 'member', $2, now() + interval '7 days', $3)`,
      [t.locationId, `hash-${newId()}`, t.userId],
    );
    await c.query(
      `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id) VALUES ($1, 'place', $2)`,
      [t.locationId, newId()],
    );
    await c.query(
      `INSERT INTO public.idempotency_keys (user_id, key, request_hash) VALUES ($1, 'k', 'h')`,
      [t.userId],
    );
    const ev = await c.query(
      `INSERT INTO public.audit_events
         (location_id, owner_account_id, actor_type, actor_id, action, entity_type, entity_id)
       VALUES ($1, $2, 'user', $3, 'create', 'place', $4) RETURNING id, at`,
      [t.locationId, t.accountId, t.userId, room],
    );
    await c.query(
      `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
       VALUES ($1, $2, $3, $4)`,
      [ev.rows[0].id, ev.rows[0].at, t.locationId, newId()],
    );
    await c.query(
      `INSERT INTO public.audit_events (owner_account_id, actor_type, actor_id, action, entity_type)
       VALUES ($1, 'user', $2, 'update', 'account')`,
      [t.accountId, t.userId],
    );
    // Step 2's inventory tables (test/leak-inventory.ts).
    await fillInventory(c, t, label, room);
    // Step 3's capture, sync, AI and label tables (test/leak-capture.ts).
    await fillCapture(c, t, label);
    // Step 4's household tables (test/leak-household.ts).
    await fillHousehold(c, t, label);
    // Step 5's vehicle tables (test/leak-vehicles.ts).
    await fillVehicles(c, t, label);
    // Step 6's token, assistant, embedding and webhook tables (test/leak-assistant.ts).
    await fillAssistant(c, t, label);
    // Step 7's export, import and stock rows (test/leak-portability.ts).
    await fillPortability(c, t, label);
    // Step 8's backup runs and release history (test/leak-operations.ts).
    await fillOperations(c, t, label);
  });
}

beforeAll(async () => {
  await db.reset();
  a = await seedTenant(db, 'tenant-a');
  b = await seedTenant(db, 'tenant-b');
  await fillTenant(a, 'a');
  await fillTenant(b, 'b');
  await ownerTx(db, async (c) => {
    await c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [b.userId]);
    await c.query(`INSERT INTO public.instance_settings (key, value) VALUES ('probe', '1')`);
    await c.query(
      `INSERT INTO public.admin_alerts (kind, dedupe_key) VALUES ('failed_jobs_rising', 'probe')`,
    );
  });
  g = await seedTenant(db, 'tenant-g', { require2fa: true });
  await fillTenant(g, 'g');
  viewerOfB = await seedUser(db, 'viewer-of-b');
  await addMember(db, b.locationId, viewerOfB, 'viewer');
  expiredOfB = await seedUser(db, 'expired-of-b');
  await addMember(db, b.locationId, expiredOfB, 'member', new Date(Date.now() - 60_000));
  memberOfG = await seedUser(db, 'member-of-g');
  await addMember(db, g.locationId, memberOfG, 'member');
  adminOfA = await seedUser(db, 'admin-of-a');
  await addMember(db, a.locationId, adminOfA, 'admin');
  allTargets = await asOwner(db, targets);
});

const scopeValue = (t: Tenant, kind: Kind) =>
  kind === 'location' ? t.locationId : kind === 'account' ? t.accountId : t.userId;

// A's session with a second factor, so require_2fa can't be what hides B's rows.
const scopeA = (): Scope => ({ userId: a.userId, mfa: true });

async function asA<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withScope(db.pools.app, scopeA(), (_tx, c) => fn(c));
}

async function sqlstate(promise: Promise<unknown>): Promise<string | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

/** A column kept_app may UPDATE on `table`, preferring `preferred`; null if none. */
async function updatableColumn(role: string, table: string, preferred: string) {
  const { rows } = await asOwner(db, (c) =>
    c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND has_column_privilege($2, format('public.%I', table_name), column_name, 'UPDATE')
        ORDER BY column_name = $3 DESC, ordinal_position`,
      [table, role, preferred],
    ),
  );
  return rows[0]?.column_name ?? null;
}

/** Rows of `table` as jsonb, read as kept_owner. */
async function rowsWhere(table: string, column: string, value: string) {
  const { rows } = await asOwner(db, (c) =>
    c.query<{ j: Record<string, unknown> }>(
      `SELECT to_jsonb(x) AS j FROM public.${ident(table)} x WHERE ${ident(column)} = $1`,
      [value],
    ),
  );
  return rows.map((r) => r.j);
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected identifier ${name}`);
  return `"${name}"`;
};

/** Inserts a jsonb row image into `table` on client `c`, typed exactly by the table's row type.
 * Generated columns (file_text.tsv, llm_calls.budget_task) are left to Postgres: a value for one
 * is refused before any policy runs. */
const insertImage = async (c: pg.ClientBase, table: string, image: Record<string, unknown>) => {
  const { rows } = await c.query<{ attname: string }>(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = format('public.%I', $1::text)::regclass AND attnum > 0
        AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
    [table],
  );
  const cols = rows.map((r) => ident(r.attname)).join(', ');
  return c.query(
    `INSERT INTO public.${ident(table)} (${cols})
     SELECT ${cols} FROM jsonb_populate_record(NULL::public.${ident(table)}, $1::jsonb)`,
    [JSON.stringify(image)],
  );
};

// ------------------------------------------------------------------------------------------

describe('catalogue', () => {
  it('forces RLS on every public table and partition, each with owner_all and a kept_app policy', async () => {
    expect(await asOwner(db, rlsProblems)).toEqual([]);
  });

  it('has no policy granted TO public', async () => {
    expect(await asOwner(db, publicPolicies)).toEqual([]);
  });

  it('has only security_invoker views, and no materialized views (L28)', async () => {
    expect(await asOwner(db, viewProblems)).toEqual([]);
  });

  it('gives kept_system policies on exactly the system tables (§7.1)', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ tablename: string }>(
        `SELECT DISTINCT tablename FROM pg_policies
          WHERE schemaname = 'public' AND 'kept_system' = ANY (roles) ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.tablename)).toEqual(
      [...SYSTEM_TABLES, ...SYSTEM_READ_TABLES, ...SYSTEM_JOB_TABLES].sort(),
    );
    const { rows: silent } = await asOwner(db, (c) =>
      c.query<{ policy: string }>(
        `SELECT format('%s.%s', p.tablename, p.policyname) AS policy
           FROM pg_policies p
           JOIN pg_policy pol ON pol.polname = p.policyname
                              AND pol.polrelid = format('public.%I', p.tablename)::regclass
          WHERE p.schemaname = 'public' AND 'kept_system' = ANY (p.roles)
            AND p.tablename = ANY ($1) AND obj_description(pol.oid, 'pg_policy') IS NULL`,
        [SYSTEM_JOB_TABLES],
      ),
    );
    expect(silent.map((r) => r.policy)).toEqual([]);
    // The read tables' policies read, and say which job they serve.
    const { rows: read } = await asOwner(db, (c) =>
      c.query<{ policy: string }>(
        `SELECT format('%s.%s %s %s', p.tablename, p.policyname, p.cmd,
                       coalesce(obj_description(pol.oid, 'pg_policy'), 'no comment')) AS policy
           FROM pg_policies p
           JOIN pg_policy pol ON pol.polname = p.policyname
                              AND pol.polrelid = format('public.%I', p.tablename)::regclass
          WHERE p.schemaname = 'public' AND 'kept_system' = ANY (p.roles)
            AND p.tablename = ANY ($1) ORDER BY 1`,
        [SYSTEM_READ_TABLES],
      ),
    );
    expect(
      read.map((r) =>
        r.policy.replace(/ the (reminder scan|embeddings backfill) \(T14\) .*$/, ' …'),
      ),
    ).toEqual(SYSTEM_READ_TABLES.map((t) => `${t}.system_select SELECT …`));
  });

  it('gives no runtime role TRUNCATE, REFERENCES or TRIGGER on a public table (TRUNCATE skips RLS)', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ grant: string }>(
        `SELECT format('%s %s %s', r, p, c.relname) AS grant
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                unnest(ARRAY['kept_app', 'kept_system', 'kept_auth']) AS r,
                unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND has_table_privilege(r, c.oid, p)
          ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.grant)).toEqual([]);
  });

  it('keeps kept_app and kept_system out of the audit partitions themselves', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ grant: string }>(
        `SELECT format('%s %s', r, c.relname) AS grant
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                unnest(ARRAY['kept_app', 'kept_system']) AS r
          WHERE n.nspname = 'public' AND c.relispartition AND c.relkind IN ('r', 'p')
            AND (has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR has_any_column_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
          ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.grant)).toEqual([]);
  });

  it('classifies every public table: a scope column, its own id, or a listed exception (L15)', async () => {
    const tables = await asOwner(db, publicTables);
    const scoped = new Set(allTargets.map((t) => t.table));
    const unclassified = tables.filter(
      (t) => !scoped.has(t) && !(t in UNSCOPED) && !(t in DEFINER_ONLY_TABLES),
    );
    expect(unclassified).toEqual([]);
    // And the exceptions still exist, so the lists don't rot.
    for (const t of [
      ...Object.keys(UNSCOPED),
      ...Object.keys(IDENTITY_SCOPE),
      ...Object.keys(DEFINER_ONLY_TABLES),
      ...SYSTEM_TABLES,
      ...SYSTEM_READ_TABLES,
      ...SYSTEM_JOB_TABLES,
    ]) {
      expect(tables, t).toContain(t);
    }
  });

  it('lists only the AI and token counters and the embeddings as definer-only (D206, step-6 T4, T6)', () => {
    expect(Object.keys(DEFINER_ONLY_TABLES).sort()).toEqual([
      'ai_breakers',
      'ai_cost_windows',
      'ai_leases',
      'ai_provider_limits',
      'ai_usage_windows',
      'embedding_state',
      'thing_embeddings',
      'token_rate_windows',
    ]);
  });

  it('has fixture rows in every definer-only table, so the door probes are not vacuous', async () => {
    const empty: string[] = [];
    for (const t of Object.keys(DEFINER_ONLY_TABLES)) {
      const { rows } = await asOwner(db, (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${ident(t)}`),
      );
      if ((rows[0]?.n ?? 0) === 0) empty.push(t);
    }
    expect(empty).toEqual([]);
  });

  // kept_app may still write a new sealed key (replacing a provider, ai/settings.ts); it never
  // reads one back: the key leaves the database only through kept.ai_provider_secret.
  it("keeps a provider's key unreadable, and the ledger unwritable, by every runtime role (D206)", async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ grant: string }>(
        `SELECT format('%s %s', r, what) AS grant
           FROM unnest(ARRAY['kept_app', 'kept_system', 'kept_auth']) AS r,
                LATERAL (VALUES
                  ('SELECT ai_providers.key_ciphertext',
                   has_column_privilege(r, 'public.ai_providers', 'key_ciphertext', 'SELECT')),
                  ('SELECT ai_providers.key_version',
                   has_column_privilege(r, 'public.ai_providers', 'key_version', 'SELECT')),
                  ('SELECT webhooks.secret_ciphertext',
                   has_column_privilege(r, 'public.webhooks', 'secret_ciphertext', 'SELECT')),
                  ('INSERT llm_calls', has_table_privilege(r, 'public.llm_calls', 'INSERT')),
                  ('UPDATE llm_calls', has_table_privilege(r, 'public.llm_calls', 'UPDATE')),
                  ('DELETE llm_calls', has_table_privilege(r, 'public.llm_calls', 'DELETE'))
                ) AS p(what, granted)
          WHERE granted ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.grant)).toEqual([]);
  });

  it("puts each tenant's rows of every partitioned table into a partition", async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ parent: string; parts: number }>(
        `SELECT p.relname AS parent,
                (SELECT count(*)::int FROM pg_inherits i WHERE i.inhparent = p.oid) AS parts
           FROM pg_class p JOIN pg_namespace n ON n.oid = p.relnamespace
          WHERE n.nspname = 'public' AND p.relkind = 'p' ORDER BY 1`,
      ),
    );
    // The partitioned tables: the audit log (step 1) and the AI call ledger (0040). A new one
    // lands here, and needs fixture rows in fillTenant().
    expect(rows.map((r) => r.parent)).toEqual(['audit_events', 'llm_calls']);
    for (const r of rows) {
      expect(r.parts, r.parent).toBeGreaterThan(0);
      for (const t of [a, b]) {
        const { rows: found } = await asOwner(db, (c) =>
          c.query<{ part: string }>(
            `SELECT DISTINCT tableoid::regclass::text AS part FROM public.${ident(r.parent)}
              WHERE owner_account_id = $1`,
            [t.accountId],
          ),
        );
        expect(found.length, `${r.parent}: rows of ${t.accountId}`).toBeGreaterThan(0);
        for (const f of found) expect(f.part).not.toBe(r.parent);
      }
    }
  });

  it('gives the runtime roles no privilege at all on the definer-only tables', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ grant: string }>(
        `SELECT format('%s %s', r, t) AS grant
           FROM unnest($1::text[]) AS t, unnest(ARRAY['kept_app', 'kept_system', 'kept_auth']) AS r
          WHERE has_table_privilege(r, format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE')
             OR has_any_column_privilege(r, format('public.%I', t), 'SELECT,INSERT,UPDATE')
             OR EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = t
                           AND p.policyname <> 'owner_all')
          ORDER BY 1`,
        [Object.keys(DEFINER_ONLY_TABLES)],
      ),
    );
    expect(rows.map((r) => r.grant)).toEqual([]);
  });

  it('gives kept_app and kept_system nothing in schema auth beyond the allowlist', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ role: string; table: string; privilege: string }>(
        `SELECT r AS role, c.relname AS table, p AS privilege
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                unnest($1::text[]) AS r, unnest($2::text[]) AS p
          WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            AND (has_table_privilege(r, c.oid, p)
                 OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                     AND has_any_column_privilege(r, c.oid, p)))
          ORDER BY 1, 2, 3`,
        [RUNTIME, TABLE_PRIVILEGES],
      ),
    );
    expect(rows).toEqual(AUTH_PRIVILEGES);
    const usage = await asOwner(db, (c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) AS r
          WHERE has_schema_privilege(r, 'auth', 'USAGE') ORDER BY 1`,
        [RUNTIME],
      ),
    );
    expect(usage.rows.map((r) => r.role)).toEqual(AUTH_SCHEMA_USAGE);
    // And the auth tables exist, so this isn't vacuous.
    const count = await asOwner(db, (c) =>
      c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'auth'`),
    );
    expect(count.rows[0].n).toBeGreaterThanOrEqual(8);
  });

  it('gives kept_auth nothing outside schema auth', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ what: string }>(
        `SELECT 'schema ' || s AS what FROM unnest(ARRAY['public', 'kept', 'kept_meta', 'pgboss']) AS s
          WHERE has_schema_privilege('kept_auth', s, 'USAGE')
         UNION ALL
         SELECT 'table ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND (has_table_privilege('kept_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR has_any_column_privilege('kept_auth', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`,
      ),
    );
    expect(rows.map((r) => r.what)).toEqual([]);
  });

  it('keeps kept_meta (the migration log) away from every runtime role', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ r: string }>(
        `SELECT r FROM unnest(ARRAY['kept_app', 'kept_system', 'kept_auth']) AS r
          WHERE has_schema_privilege(r, 'kept_meta', 'USAGE')`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('pins SECURITY DEFINER functions to kept_owner with a fixed search_path', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname IN ('public', 'kept', 'auth')
            AND (pg_get_userbyid(p.proowner) <> 'kept_owner'
                 OR NOT coalesce(p.proconfig::text[] && ARRAY['search_path=pg_catalog, public'], false))
          ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });
});

describe('catalogue: functions and key columns (review #5, #6)', () => {
  it('lets the runtime roles EXECUTE exactly the listed functions, definers deliberately', async () => {
    expect(await asOwner(db, functionInventory)).toEqual(FUNCTIONS);
  });

  it('gives kept_app UPDATE on no id, primary-key or scope column, in any table', async () => {
    expect(await asOwner(db, updatableKeys)).toEqual([]);
  });
});

describe('catalogue self-checks: each check flags the thing it looks for', () => {
  async function inRolledBack<T>(fn: (c: pg.ClientBase) => Promise<T>): Promise<T> {
    return asOwner(db, async (c) => {
      await c.query('BEGIN');
      try {
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  it('flags a table without RLS, policies or a scope', async () => {
    const found = await inRolledBack(async (c) => {
      await c.query('CREATE TABLE public.leak_probe (id uuid PRIMARY KEY, note text)');
      return {
        rls: await rlsProblems(c),
        scoped: (await targets(c)).some((t) => t.table === 'leak_probe'),
        listed: (await publicTables(c)).includes('leak_probe'),
      };
    });
    expect(found.rls).toEqual(
      expect.arrayContaining([
        'leak_probe: rls not enabled',
        'leak_probe: rls not forced',
        'leak_probe: no owner_all policy',
        'leak_probe: no kept_app policy',
      ]),
    );
    expect(found).toMatchObject({ scoped: false, listed: true });
  });

  it('flags a TO public policy, a definer view and a materialized view', async () => {
    const found = await inRolledBack(async (c) => {
      await c.query('CREATE POLICY probe ON public.places FOR SELECT USING (true)');
      await c.query('CREATE VIEW public.leak_view AS SELECT id FROM public.places');
      await c.query(
        'CREATE VIEW public.ok_view WITH (security_invoker = true) AS SELECT id FROM public.places',
      );
      await c.query('CREATE MATERIALIZED VIEW public.leak_mat AS SELECT 1 AS x');
      return { policies: await publicPolicies(c), views: await viewProblems(c) };
    });
    expect(found.policies).toEqual(['public.places.probe']);
    expect(found.views).toEqual(['public.leak_mat', 'public.leak_view']);
  });

  it('flags an unlisted definer function, a newly executable one, and a changed grant', async () => {
    const found = await inRolledBack(async (c) => {
      await c.query(
        `CREATE FUNCTION public.leak_door() RETURNS int LANGUAGE sql SECURITY DEFINER
         SET search_path = pg_catalog, public AS $$ SELECT 1 $$`,
      );
      await c.query('GRANT EXECUTE ON FUNCTION public.leak_door() TO kept_app');
      // Schema kept's default privileges hand a new function to both runtime roles.
      await c.query('CREATE FUNCTION kept.leak_open() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      await c.query('GRANT EXECUTE ON FUNCTION kept.ensure_audit_partitions(integer) TO kept_app');
      return functionInventory(c);
    });
    expect(found['public.leak_door()']).toEqual({ roles: ['kept_app'], definer: true });
    expect(found['kept.leak_open()']).toEqual({
      roles: ['kept_app', 'kept_system'],
      definer: false,
    });
    expect(found['kept.ensure_audit_partitions(integer)']?.roles).toEqual([
      'kept_app',
      'kept_system',
    ]);
    // An extension's functions are the extension's (pg_trgm here), not ours to list.
    expect(Object.keys(found).some((fn) => fn.startsWith('public.similarity('))).toBe(false);
  });

  it('flags an id, key or scope column kept_app may UPDATE', async () => {
    const found = await inRolledBack(async (c) => {
      await c.query('GRANT UPDATE (location_id) ON public.places TO kept_app');
      await c.query('GRANT UPDATE (module) ON public.location_modules TO kept_app');
      await c.query('GRANT UPDATE (id) ON public.locations TO kept_app');
      return updatableKeys(c);
    });
    expect(found).toEqual(['location_modules.module', 'locations.id', 'places.location_id']);
  });
});

describe('request path (kept_app): tenant A never reaches tenant B', () => {
  it('has fixture rows for B in every scoped table, so nothing below passes vacuously', async () => {
    const empty: string[] = [];
    for (const t of allTargets) {
      if ((await rowsWhere(t.table, t.column, scopeValue(b, t.kind))).length === 0) {
        empty.push(`${t.table}.${t.column}`);
      }
    }
    // A new table lands here until fillTenant() writes a row into it.
    expect(empty).toEqual([]);
    expect(allTargets.length).toBeGreaterThanOrEqual(17);
  });

  it("sees its own rows, so the counts below aren't empty for every tenant", async () => {
    const own: string[] = [];
    for (const t of allTargets) {
      const n = await asA(async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM public.${ident(t.table)} WHERE ${ident(t.column)} = $1`,
          [scopeValue(a, t.kind)],
        );
        return rows[0].n as number;
      });
      if (n > 0) own.push(t.table);
    }
    // Every scoped table A has rows in, except the instance tables A isn't admin of.
    expect(new Set(own)).toEqual(
      new Set(allTargets.map((t) => t.table).filter((t) => t !== 'instance_admins')),
    );
  });

  it("moves none of A's rows to B, through any id or scope column (review #5)", async () => {
    const moved: string[] = [];
    for (const t of allTargets) {
      const result = await asA(
        async (c) =>
          (
            await c.query(
              `UPDATE public.${ident(t.table)} SET ${ident(t.column)} = $1 WHERE ${ident(t.column)} = $2`,
              [scopeValue(b, t.kind), scopeValue(a, t.kind)],
            )
          ).rowCount,
      ).catch((err: { code?: string }) => err.code);
      if (![0, '42501'].includes(result as never)) moved.push(`${t.table}.${t.column}: ${result}`);
    }
    expect(moved).toEqual([]);
  });

  it("answers A's own row given B's id exactly as a missing row (the id targets)", async () => {
    const replies: string[] = [];
    for (const t of allTargets.filter((x) => x.column === 'id')) {
      for (const row of await rowsWhere(t.table, t.column, scopeValue(a, t.kind))) {
        const image = { ...row, id: scopeValue(b, t.kind) };
        const reply = await asA((c) => insertImage(c, t.table, image)).then(
          () => 'ok',
          (err: unknown) => toErrorReply(err),
        );
        if (JSON.stringify(reply) !== JSON.stringify(toErrorReply(notFound())))
          replies.push(`${t.table}: ${JSON.stringify(reply)}`);
      }
    }
    expect(replies).toEqual([]);
  });

  it("refuses A's own rows with only the scope column pointed at B", async () => {
    const results: string[] = [];
    for (const t of allTargets) {
      if (t.column === 'id') continue; // the case above
      for (const row of await rowsWhere(t.table, t.column, scopeValue(a, t.kind))) {
        const image = { ...row, [t.column]: scopeValue(b, t.kind) };
        const code = await sqlstate(asA((c) => insertImage(c, t.table, image)));
        // RLS WITH CHECK runs before constraints and foreign keys, so a policy that let the row
        // through shows up as 'ok' or as some later error, never as 42501.
        if (code !== '42501')
          results.push(`${t.table}.${t.column}: ${code} ${JSON.stringify(image)}`);
      }
    }
    expect(results).toEqual([]);
  });

  it('refuses an admin adding a user from another tenant, or one who exists nowhere (review #1)', async () => {
    const results: Record<string, string> = {};
    for (const [label, scope] of [
      ['owner', scopeA()],
      ['admin', { userId: adminOfA, mfa: true }],
    ] as const) {
      for (const [who, user] of [
        ["B's user", b.userId],
        ['no such user', newId()],
      ] as const) {
        results[`${label} inserts ${who}`] = await sqlstate(
          withScope(db.pools.app, scope, (_tx, c) =>
            c.query(
              `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'member')`,
              [a.locationId, user],
            ),
          ),
        );
        results[`${label} adds ${who} as managed`] = await sqlstate(
          withScope(db.pools.app, scope, (_tx, c) =>
            c.query(`SELECT kept.add_managed_member($1, $2, 'member', NULL)`, [a.locationId, user]),
          ),
        );
      }
    }
    // One answer for all of them: no row, no profile read, no hint whether the user exists.
    expect(new Set(Object.values(results))).toEqual(new Set(['42501']));
    const seen = await withScope(
      db.pools.app,
      { userId: adminOfA, mfa: true },
      async (_tx, c) =>
        (await c.query('SELECT 1 FROM public.user_profiles WHERE user_id = $1', [b.userId]))
          .rowCount,
    );
    expect(seen).toBe(0);
  });

  it('shows the instance tables to nobody but an instance admin', async () => {
    for (const table of ['instance_settings', 'admin_alerts']) {
      const n = await asA(async (c) => {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.${table}`);
        return rows[0].n as number;
      });
      expect(n, table).toBe(0);
    }
  });

  it('shows nothing without a scope, in any table but the reference ones', async () => {
    const tables = await asOwner(db, publicTables);
    const seen: string[] = [];
    for (const table of tables) {
      if (UNSCOPED[table] === 'reference') continue;
      if (table in DEFINER_ONLY_TABLES) {
        // No grant at all: refused outright, scope or no scope.
        const code = await sqlstate(db.pools.app.query(`SELECT 1 FROM public.${ident(table)}`));
        if (code !== '42501') seen.push(`${table}: ${code}`);
        continue;
      }
      const { rows } = await db.pools.app.query(
        `SELECT count(*)::int AS n FROM public.${ident(table)}`,
      );
      if (rows[0].n !== 0) seen.push(`${table}: ${rows[0].n}`);
    }
    expect(seen).toEqual([]);
  });

  it('refuses kept_app on the audit partitions directly', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relispartition AND c.relkind IN ('r', 'p')`,
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const { name } of rows) {
      expect(await sqlstate(asA((c) => c.query(`SELECT * FROM public.${ident(name)}`))), name).toBe(
        '42501',
      );
    }
  });

  it('refuses kept_app and kept_system on schema auth', async () => {
    expect(await sqlstate(db.pools.app.query('SELECT * FROM auth."user"'))).toBe('42501');
    expect(await sqlstate(db.pools.system.query('SELECT * FROM auth."user"'))).toBe('42501');
    expect(await sqlstate(db.pools.system.query('SELECT email FROM auth."user"'))).toBe('42501');
    expect(await sqlstate(db.pools.system.query('SELECT * FROM auth.session'))).toBe('42501');
    // The repair job's two columns, and nothing else (0007).
    expect(await sqlstate(db.pools.system.query('SELECT id, created_at FROM auth."user"'))).toBe(
      'ok',
    );
  });

  it('keeps an export run from everyone but its creator, even another admin (step-4 T4, D180)', async () => {
    const n = await withScope(db.pools.app, { userId: adminOfA, mfa: true }, async (_tx, c) => {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM public.export_runs WHERE location_id = $1',
        [a.locationId],
      );
      return rows[0].n as number;
    });
    expect(n).toBe(0);
    expect((await rowsWhere('export_runs', 'location_id', a.locationId)).length).toBeGreaterThan(0);
  });

  it("refuses B's vendor on A's claim or service and B's person on A's loan (step-4 T5)", async () => {
    const one = async (sql: string, values: unknown[]) =>
      (await asOwner(db, (c) => c.query<{ id: string }>(sql, values))).rows[0]?.id as string;
    const thing = await one('SELECT id FROM public.things WHERE name = $1', ['a thing']);
    const vendor = await one('SELECT id FROM public.vendors WHERE name = $1', ['b vendor']);
    const person = await one('SELECT id FROM public.people WHERE display_name = $1', ['b person']);
    const codes = await Promise.all([
      sqlstate(
        asA((c) =>
          c.query(
            `INSERT INTO public.claims (location_id, thing_id, opened_on, vendor_id, created_by)
             VALUES ($1, $2, current_date, $3, $4)`,
            [a.locationId, thing, vendor, a.userId],
          ),
        ),
      ),
      sqlstate(
        asA((c) =>
          c.query(
            `INSERT INTO public.service_records (location_id, thing_id, serviced_on, vendor_id,
                                                 logged_by)
             VALUES ($1, $2, current_date, $3, $4)`,
            [a.locationId, thing, vendor, a.userId],
          ),
        ),
      ),
      sqlstate(
        asA((c) =>
          c.query(
            `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at,
                                       created_by)
             VALUES ($1, $2, 'in', $3, now(), $4)`,
            [a.locationId, thing, person, a.userId],
          ),
        ),
      ),
    ]);
    expect(codes).toEqual(['42501', '42501', '42501']);
  });

  it("keeps a person's channels, devices, choices, centre and links from the other members of the same location (step-4 T7)", async () => {
    const seen = await withScope(db.pools.app, { userId: adminOfA, mfa: true }, async (_tx, c) => {
      const out: Record<string, number> = {};
      for (const table of [
        'notification_channels',
        'push_subscriptions',
        'notification_preferences',
        'notifications',
        'reminder_deliveries',
        'notification_digests',
        'calendar_feeds',
      ]) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM public.${ident(table)} WHERE user_id = $1`,
          [a.userId],
        );
        out[table] = rows[0].n as number;
      }
      return out;
    });
    expect(Object.values(seen)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // The occurrences are the location's: its admin sees them.
    const occurrences = await withScope(
      db.pools.app,
      { userId: adminOfA, mfa: true },
      async (_tx, c) =>
        (
          await c.query('SELECT 1 FROM public.reminder_occurrences WHERE location_id = $1', [
            a.locationId,
          ])
        ).rowCount,
    );
    expect(occurrences).toBeGreaterThan(0);
  });

  it("keeps a person's tokens and grants from the other members of the same location, and from every token (step-6 T4)", async () => {
    const seen = await withScope(db.pools.app, { userId: adminOfA, mfa: true }, async (_tx, c) => ({
      tokens: (await c.query('SELECT 1 FROM public.api_tokens WHERE user_id = $1', [a.userId]))
        .rowCount,
      locations: (
        await c.query('SELECT 1 FROM public.token_locations WHERE location_id = $1', [a.locationId])
      ).rowCount,
    }));
    expect(seen).toEqual({ tokens: 0, locations: 0 });
    // A's own token, as a principal, sees none of them, and reads no secret HMAC as A.
    const [token] = await rowsWhere('api_tokens', 'user_id', a.userId);
    const asToken = await withScope(
      db.pools.app,
      { userId: a.userId, mfa: true, tokenId: token?.id as string },
      async (_tx, c) => (await c.query('SELECT 1 FROM public.api_tokens')).rowCount,
    );
    expect(asToken).toBe(0);
    expect(await sqlstate(asA((c) => c.query('SELECT hash FROM public.api_tokens')))).toBe('42501');
  });

  it("keeps a person's assistant threads from everyone else, the location's admin and the instance admin included (step-6 T5, D23)", async () => {
    const tables = [
      'assistant_threads',
      'assistant_turns',
      'assistant_messages',
      'assistant_tool_results',
      'assistant_proposals',
    ];
    const count = (scope: Scope, userId: string) =>
      withScope(db.pools.app, scope, async (_tx, c) => {
        const out: number[] = [];
        for (const table of tables) {
          const { rows } = await c.query(
            `SELECT count(*)::int AS n FROM public.${ident(table)} WHERE user_id = $1`,
            [userId],
          );
          out.push(rows[0].n as number);
        }
        return out;
      });
    expect(await count(scopeA(), a.userId)).toEqual([1, 1, 3, 1, 1]);
    // adminOfA administers A's location; B is the instance admin.
    expect(await count({ userId: adminOfA, mfa: true }, a.userId)).toEqual([0, 0, 0, 0, 0]);
    expect(await count({ userId: b.userId, mfa: true }, a.userId)).toEqual([0, 0, 0, 0, 0]);
    const [token] = await rowsWhere('api_tokens', 'user_id', a.userId);
    expect(
      await count({ userId: a.userId, mfa: true, tokenId: token?.id as string }, a.userId),
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it("never lets kept_app read a webhook's sealed config or the VAPID key (step-4 T7)", async () => {
    expect(
      await sqlstate(
        asA((c) => c.query('SELECT config_ciphertext FROM public.notification_channels')),
      ),
    ).toBe('42501');
    expect(
      await sqlstate(asA((c) => c.query('SELECT label FROM public.notification_channels'))),
    ).toBe('ok');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.instance_settings (key, value)
         VALUES ('vapid', '{"publicKey": "pub", "privateKeySealed": {"v": 1}}')
         ON CONFLICT (key) DO NOTHING`,
      ),
    );
    // B is an instance admin: every other setting, never this one.
    const read = await withScope(
      db.pools.app,
      { userId: b.userId, mfa: true },
      async (_tx, c) =>
        (await c.query(`SELECT key FROM public.instance_settings WHERE key IN ('vapid', 'probe')`))
          .rows,
    );
    expect(read).toEqual([{ key: 'probe' }]);
    expect(
      await withScope(
        db.pools.app,
        { userId: b.userId, mfa: true },
        async (_tx, c) =>
          (await c.query(`UPDATE public.instance_settings SET value = value WHERE key = 'vapid'`))
            .rowCount,
      ),
    ).toBe(0);
  });

  it("keeps a person's sync ledger from the other members of the same location (T4)", async () => {
    const n = await withScope(db.pools.app, { userId: adminOfA, mfa: true }, async (_tx, c) => {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM public.sync_ops WHERE location_id = $1',
        [a.locationId],
      );
      return rows[0].n as number;
    });
    expect(n).toBe(0);
    expect((await rowsWhere('sync_ops', 'location_id', a.locationId)).length).toBeGreaterThan(0);
  });

  it('refuses kept_auth on schema public', async () => {
    expect(await sqlstate(db.pools.auth.query('SELECT * FROM public.locations'))).toBe('42501');
    expect(await sqlstate(db.pools.auth.query('SELECT kept.current_user_id()'))).toBe('42501');
  });
});

// The walls, for A and for the other ways of not belonging (review #6): an expired member, a member
// of a require_2fa location whose session has no second factor, and a viewer (who may read the
// victim's location, but write none of its rows and nothing of its owner's).
type Actor = { name: string; scope: () => Scope; victim: () => Tenant; readsVictim: boolean };
const ACTORS: Actor[] = [
  {
    name: 'tenant A, who shares nothing with B',
    scope: scopeA,
    victim: () => b,
    readsVictim: false,
  },
  {
    name: "an expired member of B's location",
    scope: () => ({ userId: expiredOfB, mfa: true }),
    victim: () => b,
    readsVictim: false,
  },
  {
    name: 'a member of a require_2fa location, without a second factor',
    scope: () => ({ userId: memberOfG, mfa: false }),
    victim: () => g,
    readsVictim: false,
  },
  {
    name: "a viewer of B's location",
    scope: () => ({ userId: viewerOfB, mfa: true }),
    victim: () => b,
    readsVictim: true,
  },
];

for (const actor of ACTORS) {
  describe(`request path (kept_app) as ${actor.name}`, () => {
    const run = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      withScope(db.pools.app, actor.scope(), (_tx, c) => fn(c));

    it("has the victim's rows to aim at", async () => {
      const empty: string[] = [];
      for (const t of allTargets) {
        if ((await rowsWhere(t.table, t.column, scopeValue(actor.victim(), t.kind))).length === 0) {
          empty.push(`${t.table}.${t.column}`);
        }
      }
      // Only B is an instance admin.
      expect(empty).toEqual(actor.victim() === b ? [] : ['instance_admins.user_id']);
    });

    if (!actor.readsVictim) {
      it("counts none of the victim's rows, in any scoped table", async () => {
        const seen: string[] = [];
        for (const t of allTargets) {
          const n = await run(async (c) => {
            const { rows } = await c.query(
              `SELECT count(*)::int AS n FROM public.${ident(t.table)} WHERE ${ident(t.column)} = $1`,
              [scopeValue(actor.victim(), t.kind)],
            );
            return rows[0].n as number;
          });
          if (n !== 0) seen.push(`${t.table}.${t.column}: ${n}`);
        }
        expect(seen).toEqual([]);
      });
    }

    it("updates and deletes none of the victim's rows", async () => {
      const touched: string[] = [];
      for (const t of allTargets) {
        const value = scopeValue(actor.victim(), t.kind);
        const col = await updatableColumn('kept_app', t.table, t.column);
        const update = col
          ? await run(
              async (c) =>
                (
                  await c.query(
                    `UPDATE public.${ident(t.table)} SET ${ident(col)} = ${ident(col)}
                      WHERE ${ident(t.column)} = $1`,
                    [value],
                  )
                ).rowCount,
            ).catch((err: { code?: string }) => err.code)
          : 'no column';
        // The one deliberate exception: an actor's own membership is theirs to delete (leaving
        // a location, 0008 app_delete_own), even in the victim's location.
        const ownRow = t.table === 'memberships' ? ' AND user_id <> $2' : '';
        const del = await run(
          async (c) =>
            (
              await c.query(
                `DELETE FROM public.${ident(t.table)} WHERE ${ident(t.column)} = $1${ownRow}`,
                ownRow ? [value, actor.scope().userId] : [value],
              )
            ).rowCount,
        ).catch((err: { code?: string }) => err.code);
        // 0 rows, or refused outright by a privilege (42501): never a row changed.
        if (![0, '42501', 'no column'].includes(update as never))
          touched.push(`update ${t.table}.${t.column}: ${update}`);
        if (![0, '42501'].includes(del as never))
          touched.push(`delete ${t.table}.${t.column}: ${del}`);
      }
      expect(touched).toEqual([]);
      for (const t of allTargets) {
        if (t.table === 'instance_admins' && actor.victim() !== b) continue;
        expect(
          (await rowsWhere(t.table, t.column, scopeValue(actor.victim(), t.kind))).length,
          t.table,
        ).toBeGreaterThan(0);
      }
    });

    it("refuses copies of the victim's rows, in every scoped table and by its own id", async () => {
      const results: string[] = [];
      for (const t of allTargets) {
        for (const image of await rowsWhere(
          t.table,
          t.column,
          scopeValue(actor.victim(), t.kind),
        )) {
          const code = await sqlstate(run((c) => insertImage(c, t.table, image)));
          if (code !== '42501') results.push(`${t.table}.${t.column}: ${code}`);
        }
      }
      expect(results).toEqual([]);
    });
  });
}

// The definer doors (security review I5): each one, called by every actor with the victim's own
// ids, refuses (42501) or answers nothing. A viewer may read what the thing shows them, but never
// an original (D117), a secret, or a write.
type Ids = Record<
  | 'thing'
  | 'box'
  | 'room'
  | 'unplaced'
  | 'type'
  | 'pin'
  | 'file'
  | 'person'
  | 'tag'
  | 'tag2'
  | 'purchase'
  | 'provider'
  | 'cap'
  | 'exportRun'
  | 'importDraft'
  | 'keptImport'
  | 'token',
  string
>;

async function victimIds(t: Tenant, label: string): Promise<Ids> {
  const one = async (sql: string, values: unknown[]) =>
    (await asOwner(db, (c) => c.query<{ id: string }>(sql, values))).rows[0]?.id as string;
  return {
    thing: await one('SELECT id FROM public.things WHERE name = $1', [`${label} thing`]),
    box: await one('SELECT id FROM public.things WHERE name = $1', [`${label} box`]),
    room: await one('SELECT id FROM public.places WHERE name = $1', [`${label} room`]),
    unplaced: t.unplacedId,
    type: await one('SELECT id FROM public.types WHERE name = $1', [`${label} gadget`]),
    pin: await one(
      `SELECT f.id FROM public.type_fields f WHERE f.owner_account_id = $1 AND f.key = 'gadget_pin'`,
      [t.accountId],
    ),
    file: await one('SELECT file_id AS id FROM public.attachments WHERE location_id = $1 LIMIT 1', [
      t.locationId,
    ]),
    person: await one('SELECT id FROM public.people WHERE display_name = $1', [`${label} person`]),
    tag: await one('SELECT id FROM public.tags WHERE name = $1', [`${label} tag`]),
    tag2: await one('SELECT id FROM public.tags WHERE name = $1', [`${label} other tag`]),
    purchase: await one('SELECT id FROM public.purchases WHERE location_id = $1 LIMIT 1', [
      t.locationId,
    ]),
    provider: await one(
      `SELECT id FROM public.ai_providers WHERE scope = 'account' AND owner_account_id = $1`,
      [t.accountId],
    ),
    cap: await one(
      `SELECT id FROM public.ai_budgets WHERE scope = 'location' AND location_id = $1`,
      [t.locationId],
    ),
    exportRun: await one('SELECT id FROM public.export_runs WHERE location_id = $1 LIMIT 1', [
      t.locationId,
    ]),
    keptImport: await one(
      `SELECT id FROM public.import_runs WHERE location_id = $1 AND source = 'kept_zip'`,
      [t.locationId],
    ),
    importDraft: await one(
      'SELECT id FROM public.import_runs WHERE created_by = $1 AND location_id IS NULL',
      [t.userId],
    ),
    token: await one(`SELECT id FROM public.api_tokens WHERE user_id = $1 AND kind = 'personal'`, [
      t.userId,
    ]),
  };
}

type Outcome = 'refused' | 'empty' | 'false' | 'rows';
type Probe = {
  name: string;
  sql: string;
  args: (ids: Ids, t: Tenant) => unknown[];
  viewer: Outcome;
};

const PROBES: Probe[] = [
  {
    name: 'thing_purchase',
    sql: 'SELECT * FROM kept.thing_purchase($1)',
    args: (i) => [i.thing],
    viewer: 'rows',
  },
  {
    name: 'thing_receipts',
    sql: 'SELECT * FROM kept.thing_receipts($1)',
    args: (i) => [i.thing],
    viewer: 'rows',
  },
  {
    name: 'thing_receipt_file',
    sql: 'SELECT * FROM kept.thing_receipt_file($1, $2)',
    args: (i) => [i.thing, i.file],
    viewer: 'empty',
  },
  {
    name: 'secret_fields_set (reveal)',
    sql: 'SELECT coalesce(bool_or(can_reveal), false) AS v FROM kept.secret_fields_set($1, NULL)',
    args: (i) => [i.thing],
    viewer: 'false',
  },
  {
    name: 'can_reveal_secret',
    sql: 'SELECT kept.can_reveal_secret($1, $2) AS v',
    args: (i, t) => [t.locationId, i.pin],
    viewer: 'false',
  },
  {
    name: 'clear_secret',
    sql: `SELECT kept.clear_secret($1, NULL, 'gadget_pin') AS v`,
    args: (i) => [i.thing],
    viewer: 'refused',
  },
  {
    name: 'person_contact_visible',
    sql: 'SELECT kept.person_contact_visible($1) AS v',
    args: (i) => [i.person],
    viewer: 'false',
  },
  {
    name: 'type_impact',
    sql: 'SELECT * FROM kept.type_impact($1)',
    args: (i) => [i.type],
    viewer: 'rows',
  },
  {
    name: 'move_things',
    sql: 'SELECT * FROM kept.move_things($1, $2, $3, NULL)',
    args: (i, t) => [[i.thing], t.locationId, i.room],
    viewer: 'refused',
  },
  {
    name: 'merge_places',
    sql: 'SELECT kept.merge_places($1, $2)',
    args: (i) => [i.room, i.unplaced],
    viewer: 'refused',
  },
  {
    name: 'merge_registry',
    sql: `SELECT kept.merge_registry('tag', $1, $2)`,
    args: (i) => [i.tag2, i.tag],
    viewer: 'refused',
  },
  {
    name: 'customise_type',
    sql: `SELECT kept.customise_type((SELECT id FROM public.types WHERE builtin_key = 'phone'), $1)`,
    args: (_i, t) => [t.accountId],
    viewer: 'refused',
  },
  {
    name: 'convert_place_to_container',
    sql: 'SELECT kept.convert_place_to_container($1, NULL)',
    args: (i) => [i.room],
    viewer: 'refused',
  },
  {
    name: 'convert_container_to_place',
    sql: 'SELECT kept.convert_container_to_place($1, NULL)',
    args: (i) => [i.box],
    viewer: 'refused',
  },
  {
    name: 'registry_use_locations',
    sql: `SELECT * FROM kept.registry_use_locations('tag', $1)`,
    args: (i) => [i.tag],
    viewer: 'refused',
  },
  {
    name: 'currencies_in_use',
    sql: 'SELECT * FROM kept.currencies_in_use()',
    args: () => [],
    viewer: 'refused',
  },
  {
    // The victim's things are "<label> thing" and "<label> box"; aimed at the victim's location,
    // so the actor's own things never answer.
    name: 'search_thing_ids',
    sql: `SELECT * FROM kept.search_thing_ids(to_tsquery('simple', 'thing:*'), NULL, 'thing', $1)`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    name: 'near_thing_names',
    sql: `SELECT * FROM kept.near_thing_names('thinh', ARRAY['thing'], ARRAY['thin_'], $1)`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    // The victim's PDF says "<label> warranty card"; aimed at the victim's location.
    name: 'search_file_ids',
    sql: `SELECT * FROM kept.search_file_ids(to_tsquery('simple', 'warranty'), $1)`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  // The AI doors (T6): a viewer reads the status line and whether AI runs, and nothing else.
  {
    name: 'ai_provider_resolved',
    sql: 'SELECT kept.ai_provider_resolved($1) AS v',
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    name: 'ai_status',
    sql: 'SELECT * FROM kept.ai_status($1)',
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    name: 'ai_provider_for',
    sql: `SELECT * FROM kept.ai_provider_for($1, 'extraction')`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  {
    name: 'ai_provider_secret',
    sql: `SELECT * FROM kept.ai_provider_secret($1, 'extraction')`,
    args: (i) => [i.provider],
    viewer: 'refused',
  },
  {
    name: 'ai_key_admit',
    sql: `SELECT * FROM kept.ai_key_admit($1, 1, 'probe')`,
    args: (i) => [i.provider],
    viewer: 'rows',
  },
  {
    name: 'ai_reserve',
    sql: `SELECT * FROM kept.ai_reserve(jsonb_build_object('paying_scope', 'account',
            'paying_account_id', $1::uuid, 'location_id', $2::uuid, 'owner_account_id', $1::uuid,
            'budget_task', 'extraction', 'estimate_tokens', 1, 'job_id', 'probe'))`,
    args: (_i, t) => [t.accountId, t.locationId],
    viewer: 'refused',
  },
  {
    name: 'ai_usage',
    sql: `SELECT * FROM kept.ai_usage('location', $1, '-infinity', 'infinity', 'task')`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  {
    // A viewer reads no cap row (only a location's admins read its cap), so nothing answers.
    name: 'ai_cap_usage',
    sql: 'SELECT * FROM kept.ai_cap_usage(ARRAY[$1::uuid])',
    args: (i) => [i.cap],
    viewer: 'empty',
  },
  {
    name: 'ai_cap_clear',
    sql: 'SELECT kept.ai_cap_clear($1) AS v',
    args: (i) => [i.cap],
    viewer: 'refused',
  },
  {
    name: 'ai_resume',
    sql: `SELECT * FROM kept.ai_resume($1, '{}')`,
    args: (i) => [i.cap],
    viewer: 'refused',
  },
  {
    name: 'ai_pause',
    sql: `SELECT kept.ai_pause(jsonb_build_object('scope', 'location', 'locationId', $1::uuid)) AS v`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  {
    name: 'claim_blank_code',
    sql: `SELECT * FROM kept.claim_blank_code(
            (SELECT code FROM public.short_ids WHERE thing_id = $1 LIMIT 1), $1, NULL)`,
    args: (i) => [i.thing],
    viewer: 'refused',
  },
  {
    name: 'merge_things',
    sql: 'SELECT kept.merge_things($1, $2) AS v',
    args: (i) => [i.box, i.thing],
    viewer: 'refused',
  },
  {
    name: 'set_file_display',
    sql: `SELECT kept.set_file_display($1,
            '[{"variant": "display", "width": 1, "height": 1, "bytes": 1}]') AS v`,
    args: (i) => [i.file],
    viewer: 'refused',
  },
  {
    name: 'ai_ensure_brand',
    sql: `SELECT kept.ai_ensure_brand($1, 'Probe brand') AS v`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  {
    name: 'purchase_lines_used_elsewhere',
    sql: 'SELECT kept.purchase_lines_used_elsewhere($1, NULL) AS n',
    args: (i) => [i.purchase],
    viewer: 'refused',
  },
  // The rest of the AI gate and pacer (T6, T9): charging the victim's account, and reading or
  // moving its key's breaker, lease and rate-limit window. A viewer pays for nothing; since 0096
  // its assistant turn runs on the account's key, so it reaches that key's pacer and breaker
  // (rate-limit bookkeeping, no spending: kept.ai_provider_reachable()), and no other door here.
  {
    name: 'ai_settle',
    sql: `SELECT * FROM kept.ai_settle(jsonb_build_object('paying_scope', 'account',
            'paying_account_id', $1::uuid, 'location_id', $2::uuid, 'owner_account_id', $1::uuid,
            'budget_task', 'extraction', 'job_id', 'probe', 'request_id', 'probe',
            'task', 'extract_thing', 'provider_kind', 'groq', 'model', 'probe'),
            '{"sent": false}', 'ok', NULL)`,
    args: (_i, t) => [t.accountId, t.locationId],
    viewer: 'refused',
  },
  {
    name: 'ai_key_release',
    sql: `SELECT kept.ai_key_release($1, 1, 'probe') AS v`,
    args: (i) => [i.provider],
    viewer: 'false',
  },
  {
    name: 'ai_breaker_state',
    sql: 'SELECT * FROM kept.ai_breaker_state($1)',
    args: (i) => [i.provider],
    viewer: 'rows',
  },
  {
    name: 'ai_observe',
    sql: 'SELECT kept.ai_observe($1, NULL, NULL) AS v',
    args: (i) => [i.provider],
    viewer: 'rows',
  },
  {
    name: 'ai_trip',
    sql: `SELECT kept.ai_trip($1, now() + interval '1 hour', 'rate_limited') AS v`,
    args: (i) => [i.provider],
    viewer: 'rows',
  },
  {
    name: 'ai_clear_trip',
    sql: 'SELECT kept.ai_clear_trip($1) AS v',
    args: (i) => [i.provider],
    viewer: 'refused',
  },
  {
    name: 'ai_cap_set',
    sql: `SELECT kept.ai_cap_set(jsonb_build_object('scope', 'location', 'locationId', $1::uuid,
            'tokensPerMonth', 1)) AS v`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  // The instance admin's doors: B is an instance admin, and none of the actors here is.
  {
    name: 'ai_instance_calls',
    sql: `SELECT * FROM kept.ai_instance_calls('{}', NULL)`,
    args: () => [],
    viewer: 'refused',
  },
  {
    name: 'ai_price_set',
    sql: `SELECT kept.ai_price_set(jsonb_build_object('providerKind', 'groq', 'model', 'probe',
            'inputPerMtok', 1, 'outputPerMtok', 1, 'currency', 'USD')) AS v`,
    args: () => [],
    viewer: 'refused',
  },
  {
    name: 'ai_price_remove',
    sql: `SELECT kept.ai_price_remove('groq', 'b-vision') AS v`,
    args: () => [],
    viewer: 'refused',
  },
  {
    name: 'ai_recost_unknown',
    sql: `SELECT kept.ai_recost_unknown('groq', 'b-vision', '-infinity') AS v`,
    args: () => [],
    viewer: 'refused',
  },
  // (0046, T17a) The victim location's next numbered code.
  {
    name: 'next_own_code',
    sql: 'SELECT kept.next_own_code($1) AS v',
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  // (0049, step-4 T4) The claim-pack job's doors, on the victim's run: its creator's alone.
  {
    name: 'export_run_claim',
    sql: 'SELECT * FROM kept.export_run_claim($1)',
    args: (i) => [i.exportRun],
    viewer: 'refused',
  },
  {
    name: 'export_run_progress',
    sql: 'SELECT kept.export_run_progress($1, 1, 2) AS v',
    args: (i) => [i.exportRun],
    viewer: 'refused',
  },
  {
    name: 'export_run_finish',
    sql: `SELECT kept.export_run_finish($1, NULL, 'failed', 'probe') AS v`,
    args: (i) => [i.exportRun],
    viewer: 'refused',
  },
  // (0101) Whether an export of the victim's location runs: its owners' and admins' only.
  {
    name: 'export_running',
    sql: 'SELECT kept.export_running($1) AS v',
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  // (0105) A token's name and creator, for whoever sees it act: a viewer of the victim's
  // location reads it (members see who changed their location); nobody else does.
  {
    name: 'token_actor_names',
    sql: 'SELECT * FROM kept.token_actor_names(ARRAY[$1::uuid])',
    args: (i) => [i.token],
    viewer: 'rows',
  },
  // (0070, step-6 T4) The token doors, aimed at the victim's user, location and token.
  {
    name: 'token_oauth_grant',
    sql: `SELECT kept.token_oauth_grant($1, 'https://probe.example.test/c.json', 'write',
                                        ARRAY[$2::uuid], 'probe') AS v`,
    args: (_i, t) => [t.userId, t.locationId],
    viewer: 'refused',
  },
  {
    name: 'token_oauth_for',
    sql: `SELECT * FROM kept.token_oauth_for($1, 'https://b.example.test/client.json')`,
    args: (_i, t) => [t.userId],
    viewer: 'refused',
  },
  {
    name: 'token_rate_hit',
    sql: `SELECT * FROM kept.token_rate_hit($1, 'read', 100)`,
    args: (i) => [i.token],
    viewer: 'refused',
  },
  {
    name: 'revoke_tokens_for',
    sql: `SELECT kept.revoke_tokens_for($1, $2, 'admin') AS v`,
    args: (_i, t) => [t.userId, t.locationId],
    viewer: 'refused',
  },
  // (0073, step-6 T5) Redaction, aimed at the victim's user and location.
  {
    name: 'redact_assistant_for',
    sql: 'SELECT kept.redact_assistant_for($1, $2) AS v',
    args: (_i, t) => [t.userId, t.locationId],
    viewer: 'refused',
  },
  // (0076, step-6 T6) The embedding doors, aimed at the victim's location. A viewer sees its
  // things' texts and matches, as keyword search does; it writes no vector and reads no status.
  {
    name: 'embedding_backlog',
    sql: `SELECT * FROM kept.embedding_backlog($1, 'provider:openai:probe', 10)`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    name: 'embedding_store',
    sql: `SELECT kept.embedding_store($1, 'provider:openai:probe', '[]') AS v`,
    args: (_i, t) => [t.locationId],
    viewer: 'refused',
  },
  {
    name: 'semantic_thing_ids',
    sql: `SELECT * FROM kept.semantic_thing_ids('provider:openai:probe', '[1,0,0]', $1, 10)`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  // (0099) The editor's job's row for one thing: a viewer sees its text, as the backlog's.
  {
    name: 'embedding_backlog_thing',
    sql: `SELECT * FROM kept.embedding_backlog_thing($1, 'provider:openai:probe')`,
    args: (i) => [i.thing],
    viewer: 'rows',
  },
  // (0078, step-6 T7) Webhooks, aimed at the victim's location. A viewer's write would fan out,
  // so it learns that a hook listens; nothing else.
  {
    name: 'webhooks_listening',
    sql: `SELECT kept.webhooks_listening($1, 'thing.created') AS v`,
    args: (_i, t) => [t.locationId],
    viewer: 'rows',
  },
  {
    name: 'disable_webhooks_for',
    sql: 'SELECT kept.disable_webhooks_for($1, $2) AS v',
    args: (_i, t) => [t.userId, t.locationId],
    viewer: 'refused',
  },
  // (0080, step-7 T4) The victim's archive run with no target, aimed at the victim's location:
  // only its creator sets it.
  {
    name: 'set_import_target',
    sql: 'SELECT kept.set_import_target($1, $2) AS v',
    args: (i, t) => [i.importDraft, t.locationId],
    viewer: 'refused',
  },
  // (0083, step-7 T5) The victim's running Kept import: its history and its label codes.
  {
    name: 'import_history',
    sql: `SELECT kept.import_history($1, '[]') AS v`,
    args: (i) => [i.keptImport],
    viewer: 'refused',
  },
  {
    name: 'adopt_short_code',
    sql: `SELECT kept.adopt_short_code($1, '9Z9Z9Z', 'blank', NULL, NULL) AS v`,
    args: (i) => [i.keptImport],
    viewer: 'refused',
  },
  // (0085, step-7 T6) The victim's secret field: its account owner's alone, a viewer's too.
  {
    name: 'field_conversion_preview',
    sql: `SELECT * FROM kept.field_conversion_preview($1, '{"toSecret": false}')`,
    args: (i) => [i.pin],
    viewer: 'refused',
  },
  {
    name: 'field_conversion_rows',
    sql: 'SELECT * FROM kept.field_conversion_rows($1, NULL, 10)',
    args: (i) => [i.pin],
    viewer: 'refused',
  },
  {
    name: 'apply_field_conversion',
    sql: `SELECT kept.apply_field_conversion($1, '{"toSecret": false}', '[]', true) AS v`,
    args: (i) => [i.pin],
    viewer: 'refused',
  },
];

/**
 * kept_app's definer doors that no probe above aims at a victim, and why. A new kept_app definer
 * must land in PROBES or here (the check below), so no door arrives unprobed by accident.
 */
const UNPROBED_DOORS: Record<string, string> = {
  'kept.admin_location_ids()': "no argument: reads the caller's own memberships",
  'kept.current_owner_account_id()': "no argument: the caller's own account",
  'kept.fellow_member_ids()': 'no argument: people who share a location with the caller',
  'kept.is_instance_admin()': 'no argument: whether the caller is one',
  'kept.owns_location(uuid)': "a boolean about the caller's own ownership; no row data",
  'kept.visible_location_ids()': "no argument: the caller's own memberships",
  'kept.writable_location_ids()': "no argument: the caller's own memberships",
  'kept.admin_account_ids()': "no argument: the caller's own memberships",
  'kept.visible_account_ids()': "no argument: the caller's own memberships",
  'kept.writable_account_ids()': "no argument: the caller's own memberships",
  'kept.recovery_kit_acknowledged()': "no argument: the caller's own flag",
  'kept.current_user_managed()': "no argument: the caller's own flag",
  'kept.deleted_locations()': "no argument: the caller's own deleted locations",
  'kept.accept_invite(text,text)': 'takes an invite token, not a tenant id',
  'kept.claim_invite(text,text)': 'takes an invite token, not a tenant id',
  'kept.invite_preview(text)': 'takes an invite token, not a tenant id',
  'kept.ensure_account(text,text,text)': "only ever creates the scope's own user's account",
  'kept.max_member_expiry(uuid)': 'a date limit the insert policy uses; no row data',
  'kept.person_contact_writable(uuid)': "the contacts insert policy's check; a boolean",
  'kept.managed_reset_location(uuid)': "a managed person's reset authority (D197); a boolean",
  'kept.admin_user_summaries(uuid[])': 'instance admins only; role counts, no tenant rows',
  'kept.add_managed_member(uuid,uuid,text,timestamp with time zone)':
    'checks the caller administers the location itself (0010)',
  'kept.create_managed_profile(uuid,text)': 'checks the caller administers a location (0006)',
  'kept.delete_location(uuid)': 'owner only, checked inside (0006 §5)',
  'kept.restore_location(uuid)': 'owner only, checked inside (0006 §5)',
  'kept.set_location_require_2fa(uuid,boolean)': 'owner only, checked inside (0006 §5)',
  'kept.set_location_successor(uuid,uuid)': 'owner only, checked inside (0006 §5)',
  'kept.was_member_of(uuid)':
    "a boolean about the caller's own past membership (T19, D210); no row data",
  'kept.undo_creator(uuid,uuid)':
    'answers only for the event app.undo names, in a location the caller writes (0056); probed in src/db/phase-b-fixes.test.ts',
  'kept.undo_holds_file(uuid,uuid)':
    'a boolean, only for the event app.undo names, in a location the caller writes (0056)',
  'kept.token_verify(text,text)':
    "takes a token's lookup and HMAC, not a tenant id: it is how a request gets its scope (0070)",
  'kept.embedding_status_instance()':
    'no argument: instance admins only, counts per source and model, no location (0076)',
};

describe('definer doors: every kept_app door is probed, or listed with its reason', () => {
  it('leaves no kept_app definer out', () => {
    const probed = new Set(PROBES.map((p) => p.name.split(' ')[0]));
    const doors = Object.entries(FUNCTIONS)
      .filter(([, f]) => f.definer && f.roles.includes('kept_app'))
      .map(([sig]) => sig);
    const unaccounted = doors.filter(
      (sig) => !probed.has(sig.slice('kept.'.length, sig.indexOf('('))) && !(sig in UNPROBED_DOORS),
    );
    expect(unaccounted).toEqual([]);
    // And the list doesn't rot: each entry is still a kept_app door.
    expect(Object.keys(UNPROBED_DOORS).filter((sig) => !doors.includes(sig))).toEqual([]);
  });
});

for (const actor of ACTORS) {
  describe(`definer doors (kept_app) as ${actor.name}`, () => {
    it("open onto none of the victim's rows", async () => {
      const victim = actor.victim();
      const ids = await victimIds(victim, victim === b ? 'b' : 'g');
      for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();
      const outcomes: Record<string, Outcome> = {};
      for (const probe of PROBES) {
        // Always rolled back (the outcome is thrown out of the transaction), so a door that did
        // open changes nothing for the probes after it.
        outcomes[probe.name] = await withScope(db.pools.app, actor.scope(), async (_tx, c) => {
          const { rows } = await c.query(probe.sql, probe.args(ids, victim));
          let outcome: Outcome = 'rows';
          if (rows.length === 0) outcome = 'empty';
          else if (rows.length === 1 && Object.keys(rows[0]).length === 1 && rows[0].v === false)
            outcome = 'false';
          throw { outcome };
        }).catch((err: { code?: string; outcome?: Outcome }) => {
          if (err.outcome) return err.outcome;
          if (err.code === '42501') return 'refused' as const;
          throw err;
        });
      }
      const expected = Object.fromEntries(
        PROBES.map((p) => [
          p.name,
          actor.readsVictim ? p.viewer : outcomes[p.name] === 'rows' ? 'no rows' : outcomes[p.name],
        ]),
      );
      expect(outcomes).toEqual(expected);
    });
  });
}

describe('worker path (kept_system)', () => {
  const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    withSystem(db.pools.system, (_tx, c) => fn(c));

  it('sees both tenants in the system tables', async () => {
    for (const table of [...SYSTEM_TABLES, ...SYSTEM_READ_TABLES, ...SYSTEM_JOB_TABLES]) {
      const n = await asSystem(async (c) => {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.${ident(table)}`);
        return rows[0].n as number;
      });
      expect(n, table).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads, changes and writes nothing in any other table', async () => {
    const tables = (await asOwner(db, publicTables)).filter(
      (t) => !SYSTEM_TABLES.includes(t) && !SYSTEM_JOB_TABLES.includes(t),
    );
    expect(tables.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const table of tables) {
      const count = await asSystem(async (c) => {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.${ident(table)}`);
        return rows[0].n as number;
      }).catch((err: { code?: string }) => err.code);
      // The read tables are read on purpose (above); nothing else is.
      if (!SYSTEM_READ_TABLES.includes(table) && ![0, '42501'].includes(count as never))
        problems.push(`select ${table}: ${count}`);

      const col = await updatableColumn('kept_system', table, '');
      if (col) {
        const updated = await asSystem(
          async (c) =>
            (await c.query(`UPDATE public.${ident(table)} SET ${ident(col)} = ${ident(col)}`))
              .rowCount,
        ).catch((err: { code?: string }) => err.code);
        if (![0, '42501'].includes(updated as never)) problems.push(`update ${table}: ${updated}`);
      }
      const deleted = await asSystem(
        async (c) => (await c.query(`DELETE FROM public.${ident(table)}`)).rowCount,
      ).catch((err: { code?: string }) => err.code);
      if (![0, '42501'].includes(deleted as never)) problems.push(`delete ${table}: ${deleted}`);

      const [image] = await asOwner(db, (c) =>
        c.query<{ j: Record<string, unknown> }>(
          `SELECT to_jsonb(x) AS j FROM public.${ident(table)} x LIMIT 1`,
        ),
      ).then((r) => r.rows.map((x) => x.j));
      if (image) {
        const code = await sqlstate(asSystem((c) => insertImage(c, table, image)));
        if (code !== '42501') problems.push(`insert ${table}: ${code}`);
      } else {
        problems.push(`insert ${table}: no fixture row to copy`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('refuses kept_system on the audit partitions directly', async () => {
    const code = await sqlstate(
      asSystem((c) => c.query(`SELECT * FROM public.audit_events_default`)),
    );
    expect(code).toBe('42501');
  });
});

describe('id collision (§7.7)', () => {
  /** The error a request would answer with for `promise`, or 'ok'. */
  async function replyTo(promise: Promise<unknown>) {
    try {
      await promise;
      return 'ok';
    } catch (err) {
      return toErrorReply(err);
    }
  }

  const insertPlace = (id: string) =>
    asA((c) =>
      c.query(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'probe')`, [
        id,
        a.locationId,
      ]),
    );

  it("answers a client-supplied id that exists in B exactly as a random id that doesn't exist", async () => {
    // A request for a row by an id that exists nowhere: the route's own 404.
    const missing = toErrorReply(notFound());
    // A's own location, B's existing place id: RLS lets the row through, the primary key refuses.
    const collision = await replyTo(insertPlace(b.unplacedId));
    expect(collision).toEqual(missing);
    // A read of B's id under A's scope finds nothing, so a route answers the same 404.
    const seen = await asA(async (c) => {
      const { rows } = await c.query('SELECT id FROM public.places WHERE id = $1', [b.unplacedId]);
      return rows.length;
    });
    expect(seen).toBe(0);
    // Pointing the row at B's location instead is refused by RLS: the same body again.
    const intoB = await replyTo(
      asA((c) =>
        c.query(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'probe')`, [
          b.unplacedId,
          b.locationId,
        ]),
      ),
    );
    expect(intoB).toEqual(missing);
    // And a fresh id goes in, so the refusals above are about the id, not the insert.
    expect(await replyTo(insertPlace(newId()))).toBe('ok');
  });

  it('answers a collision on a location id the same way', async () => {
    const reply = await replyTo(
      asA((c) =>
        c.query(
          `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency)
           VALUES ($1, $2, 'home', 'x', 'UTC', 'EGP')`,
          [b.locationId, a.accountId],
        ),
      ),
    );
    expect(reply).toEqual(toErrorReply(notFound()));
  });
});
