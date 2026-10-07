# Step 6 security review, 2026-10-06 (T25)

A review of step 6's new surfaces (plan `2026-09-30-step-6-assistant-mcp.md`, Task 25): personal
tokens and the public API, `/mcp`, OAuth connectors with CIMD, the assistant, webhooks, OIDC
sign-in and semantic search, plus the walk of every `SECURITY DEFINER` door for token principals.
The code was read, and a test was written wherever a hole looked possible. Every high and medium
finding is fixed with a test. The changes the schema needs are queued for the migration owner.
The lows are listed at the end and left as they are.

**Result: 0 high, 5 medium (all fixed), 5 schema items queued, 19 low (left).**

## How it was run

- The code was read area by area: tokens, MCP and OAuth by the reviewer; the assistant, webhooks
  with OIDC, and semantic search with the definer walk by three read-only sub-reviews whose
  findings were checked against the code before acting on them.
- Tests were run by file (the machine was at load 30–40). They ran on the dev Postgres (5452) with
  the AI mock provider only.
- `test/leak.test.ts` was run after the fixes (see "Verification").

## Medium (fixed)

### M1. Better Auth's OAuth client and consent management was served to any signed-in person

- **What:** `mcp()` is Better Auth's OAuth provider, which mounts session-authenticated
  `/oauth2/create-client`, `update-client`, `client/rotate-secret`, `delete-client`, `get-client`,
  `get-clients` and the consent CRUD under `/api/v1/auth/`. No `clientPrivileges` hook was set, so
  every signed-in person could call them, a viewer or a managed account included.
- **Impact:** anyone could register a client with any redirect URI and any display name. That is
  Dynamic Client Registration by another door (Q8 keeps DCR off). It also enables consent
  phishing: Kept's consent page names an app that calls itself "Claude" while the code goes to the
  registrant's redirect URI (D179).
- **Fix:** all ten paths are in `DISABLED_AUTH_PATHS` (`apps/server/src/auth/auth.ts`). Connectors
  arrive through CIMD only. A person's grants stay on Kept's own Connections routes.
- **Test:** `src/oauth/oauth.test.ts`, "serves none of the provider's client or consent management
  to a signed-in person". Each path answers 404, and no client row is written.

### M2. A webhook's URL reached every member and read token through the activity feed

- **What:** webhook audit images carried `url` as a plain field. `GET /api/v1/activity` shows a
  location's events to every member (viewers included), and it is open to read tokens.
- **Impact:** a receiver's URL is often its credential (a Slack or Discord incoming hook, a Home
  Assistant `/api/webhook/<id>`, an n8n catch hook). A viewer could read it and post forged events
  to any receiver that doesn't check `Kept-Signature`. Hooks are otherwise admin-only
  (`webhooks.manage`).
- **Fix:** `webhook.url` is classed `secret` in `FIELD_CLASSES` (`src/audit/classes.ts`), so the
  log stores `{changed: true}` only.
- **Test:** `src/webhooks/webhooks.test.ts`, the create case. The diff's `url` is `{changed, class:
  'secret'}`, and Talia's (viewer) activity feed doesn't contain the receiver's URL.
- **Not fixed by this:** rows written before the fix still hold URLs (S3).

### M3. D180 could be undone by switching a hook back on

- **What:** `PATCH /api/v1/webhooks/:id {active: true}` cleared `disabled_reason =
  'creator_lost_role'` without asking whether the creator still administers the location.
- **Impact:** any admin could restart a departed admin's hook. Events then went to that person's
  URL with nobody responsible for it, and the membership trigger can't fire for them again.
- **Fix:** re-enabling a `creator_lost_role` hook is refused with 400 ("add a new one"), in
  `src/webhooks/service.ts`. The new hook then belongs to the admin who adds it.
- **Test:** `src/webhooks/webhooks.test.ts`, the D180 case.

### M4. Proposals in a location the person lost were still served in full

- **What:** `kept.redact_assistant_in` only sets open proposals to `cancelled`. It leaves `args`,
  `before`, `refs` and `result` alone, and leaves confirmed, failed and conflict ones as they are.
  `GET /assistant/threads/:id` and `GET /assistant/turns/:id` returned all of them.
- **Impact:** `before` holds the thing's fields (notes, model, aliases). `refs` holds the
  location's name and the names and paths of things and places.
- **Fix:** `proposalsOf()` (`src/assistant/threads.ts`) returns only proposals whose location is
  still in `kept.visible_location_ids()`. Scrubbing the rows themselves is S1.
- **Test:** `src/assistant/assistant.test.ts`, the D164 case. After Louis loses Home, the thread
  and the turn list no proposals.

### M5. Assistant results and answers that didn't name their location escaped redaction

- **What, part 1:** a read was stored by the `location_id` argument plus the location ids found
  literally in its output. `thing_history`, `find_documents` and `upcoming` (no `thing`) answer
  without one, so a call that named only a thing was stored with no location, and D164's trigger
  never matched it.
- **What, part 2:** a turn cited only what its own tools touched. The history fed back to the
  model (earlier turns' results) wasn't cited, so an answer restating an earlier result survived
  the loss of that result's location.
- **Fix:** `runTool()` reports the locations it resolved (`ToolContext.onLocations`,
  `src/tools/context.ts` and `types.ts`). The loop (`src/assistant/loop.ts`) stores each result by
  those as well, and the turn's messages cite them along with every location its history
  messages cite (`RunCalls.reached`). The payer still follows what the outputs name (`touches`,
  Q3), so billing is unchanged.
- **Test:** `src/assistant/assistant.test.ts`, "a result naming no location, and a later answer
  drawn from it, read removed". The test calls `thing_history` by `thing_id`, then asks a
  second question answered from history. After Louis loses Home, both answers and the result read
  `redacted`.

## For the migration owner (schema)

| # | Need | Why |
|---|---|---|
| S1 | `kept.redact_assistant_in`: for every proposal with `location_id = p_location` (any status), blank `args`, `before`, `refs`, `result` (or delete the rows) | M4 at the source; today only the read hides them |
| S2 | `assistant_messages` app_insert policy: `cited_location_ids <@ ARRAY(SELECT kept.visible_location_ids())` | Race: an answer built from a location can be inserted after the membership delete already redacted, and then never is (low-medium) |
| S3 | Data fix: strip `url` from `audit_events.diff` (or set it to `{"changed":true,"class":"secret"}`) where `entity_type = 'webhook'` | M2's rows from before the fix |
| S4 | Revoke `EXECUTE` on `kept.embedding_mark` from kept_app (only the kept_system backfill calls it); `kept.embedding_status(uuid)` has no caller | A member or write token with raw SQL could skew the instance's embedding totals for its own location (low) |
| S5 | Optional: webhook fan-out (`webhooks_listening` or the fan-out query) also requires the creator to still be owner/admin with an unexpired membership | Closes L14's ≤15-minute expiry gap without waiting for `expire-memberships` |

## Low (left)

**Tokens, MCP, OAuth**

- **L1.** The consent POST writes the grant for Fastify's `client_id` query parameter, while Better
  Auth issues the code for the `client_id` inside the signed query. Both parse the same string,
  and duplicates fail validation, so no difference between the two parsers was found. A
  defence-in-depth check that they are equal is still cheap to add.
- **L2.** `/mcp`'s Origin check is the SDK's: hostname only, ignoring port and scheme. A bearer is
  required anyway.
- **L3.** An OAuth JWT's `scope` claim isn't intersected with the grant row's scope. The grant
  (what the person consented to) wins, so a client never exceeds its consent.
- **L4.** A client revoking its own access token at `/oauth2/revoke` doesn't end the grant. The
  JWT stays usable until it expires (≤ 1 h). Revoking in Connections ends it at once.
- **L5.** Unauthenticated `/mcp` and bearer `/api/v1` requests cost one `token_verify` query each,
  before any rate limit. Bounding them is the reverse proxy's job.
- **L6.** `GET …/attachments`, open to read tokens, returns signed `thumbUrl`/`displayUrl`.
  `TOKEN_ROUTES` says "never the bytes or a signed URL". The data is in the token's own
  locations.
- **L7.** A tool refusal's hint is an `AppError`'s message (`refusalOf`), which could carry a
  user-written name outside `untrusted`.
- **L8.** At the database level a write token of an admin gets `admin_location_ids()`. Routes keep
  tokens off every admin route (`NEVER_FOR_TOKENS`), and the MCP tools have no admin action.
- **L9.** The production `cimdFetch()` has no logger (`AuthDeps` lacks one), so the guard's
  refusal reasons aren't logged (already in the T10–T12 notes).
- **L10.** The definer walk found 100 `SECURITY DEFINER` doors granted to kept_app: 61 are
  token-safe, 5 are unreachable, and 34 widen to the user or account for a token. The 34 are
  `current_owner_account_id`, `owns_location`, `max_member_expiry`, `deleted_locations`,
  `restore_location`, the invite doors (`accept_invite`, `claim_invite`, `invite_preview`),
  `ensure_account`, `was_member_of`, the AI cascade, key, cap and usage doors, the
  field-conversion doors, and the account-level registry and type doors. None is reachable from
  `TOKEN_ROUTES` or an MCP tool with an argument the caller controls. The AI gate doors
  (`ai_reserve`, `ai_settle`, `ai_key_admit`, …) are reached by semantic search, but only with
  server-derived payer and provider ids. They stay latent as long as routes and tools are added
  through `TOKEN_ROUTES`' review.
- **L11.** Tenant jobs drop `app.token_id` (`jobs/boss.ts` keeps only user and mfa). `embed-thing`
  is queued by token writes but takes a server-chosen thing id. A future token-triggered job
  that takes a caller-chosen id would widen silently, so the token id belongs in the job's
  scope.

**Assistant**

- **L12.** A confirmed proposal runs with its stored args. Without a `location_id` or a subject,
  `runTool` picks "the only eligible location" again, so a change in reach within the 10 minutes
  could land the write somewhere other than where the card said. The role there is still
  checked.
- **L13.** Answers keep any external markdown links and images on the server. D179 holds because
  the web renders link-only markdown. Any future consumer of stored answers (export, mail, MCP)
  must strip them.
- **L14.** Provider error messages are logged (cut to 200 characters, keys scrubbed). A provider's
  400 could echo a little of the input. This is unconfirmed.
- **L15.** `kept.redact_assistant_for` lets a location's admin blank another current member's
  assistant results there. This affects integrity only; nothing is disclosed.

**Webhooks**

- **L16.** Gaps around a creator who stops administering a hook:
  - A membership past `expires_at` keeps its creator's hooks active until `expire-memberships`
    deletes it (≤ 15 min, S5).
  - A disabled (banned) account keeps its memberships, so its hooks keep delivering.
  - An admin hidden by a location's 2FA requirement keeps active hooks.
- **L17.** With `ssrf_allow_private` on, any location admin's test ping reaches the LAN and sees
  the HTTP status (by D83). The setting's hint should say so.
- **L18.** No test covers the hex form of an IPv4-mapped IPv6 address (`[::ffff:7f00:1]`). Node's
  `BlockList` should refuse it under the IPv4 rules (inferred from Node's documentation, not run).

**OIDC**

- **L19.** Three gaps, each needing an admin-configured identity provider:
  - With an identity provider that asserts unverified emails, `account_not_linked` (an account
    has that email) versus `email_unverified` (none does) tells which addresses have accounts.
  - Kept checks no `nonce`; state and PKCE with the back-channel code exchange cover it.
  - A discovered `userinfo_endpoint` isn't required to be https.

**Semantic search** (no leak found). `meaningCandidates` scans every visible location on a model
when a group spans several. Hits from filtered-out locations then take places in the 50-row cap
before being filtered. That is a correctness issue, not a leak.

## What holds

- **Tokens and the public API.**
  - `TOKEN_ROUTES` is an allowlist checked against `NEVER_FOR_TOKENS`.
  - A read token never reaches a write route.
  - Rate limits are per token in Postgres (120 reads and 30 writes a minute). MCP tool calls count
    against the same limits.
  - Revocation is effective on the next statement, because the RLS functions read the token row
    every time.
  - The scope is intersected with the creator's current memberships (D180).
  - `require_2fa` locations need `created_with_mfa`.
  - Audit actors are `token` rows pinned by policy.
  - `api_tokens.hash` is unreadable by kept_app.
  - The idempotency row never stores the secret.
- **MCP.**
  - Host is the public host or a former one. Origin is none or Kept's own.
  - The bearer is verified before the handler runs.
  - The factory registers only the tools allowed by the token's scope, role and modules.
    `runTool` re-checks every call.
  - Envelopes are kept under 8 KB by `fit()`, which never cuts a string or an id.
  - User text appears only under `untrusted`.
- **OAuth.**
  - DCR is off.
  - PKCE and the resource are enforced by the provider.
  - The JWT is verified against Kept's own JWKS, its issuer and `aud = <public URL>/mcp`.
  - `cnf` tokens are refused.
  - The grant row is read on every call, so revoking in Connections takes effect at the next
    call.
  - CIMD is fetched through `guardedFetch` with private addresses always refused, the address
    pinned and redirects refused.
  - The discovery documents return 404 unless the provider is mounted, which needs an https
    public URL.
- **Assistant.**
  - Writes are always cards bound to an args hash and expire in 10 minutes.
  - A proposal can be confirmed only once, by its own person.
  - The person's role, the modules and their membership are re-checked when they confirm.
  - Viewers get the fixed sentence and no card, and can't own a proposal.
  - No content reaches `llm_calls` or the logs.
  - Threads are invisible to admins, instance admins and tokens.
  - No IDOR was found on thread, turn or proposal ids.
- **Webhooks.**
  - The secret is write-only: it appears only in the create and rotate answers. kept_app has no
    SELECT on the ciphertext, and the audit stores `{changed}`.
  - Signing is HMAC-SHA256 over `t.body`, with the AAD `webhooks|<id>|secret`.
  - SSRF is checked on create, on update, and at connect time against every resolved address,
    with redirects refused.
  - Payloads carry ids and field names only.
  - Hooks are disabled on membership loss or demotion. Delivery re-checks `active`.
  - Tokens are refused.
- **OIDC.**
  - No implicit linking.
  - `email_verified` must be `true`.
  - Invites match the email.
  - Linking needs a fresh session.
  - The redirect comes from `baseURL`, and callback URLs pass Better Auth's origin check.
- **Semantic search.**
  - `kept.semantic_thing_ids` filters by `visible_location_ids()`, which is token-intersected.
  - The query vector is computed by the server.
  - kept_app can't read the vector tables.
  - The backlog doors need visibility or kept_system.
  - The embedded text holds no secret, serial or amount.

## Verification

See the commit for the test runs: `src/oauth/oauth.test.ts`, `src/webhooks/webhooks.test.ts`,
`src/assistant/assistant.test.ts`, `test/leak.test.ts`, and server `tsc`.
