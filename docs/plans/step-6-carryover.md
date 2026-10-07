# Step 6 carry-over

Written on 2026-10-07 in the finishing pass for steps 6–8. It lists the work left open in build
step 6 and where each piece goes. An item marked "proposed" has no plan that takes it yet, and the
maintainer decides. The two reviews keep their own lists of lows:
[security-step6-2026-10-06.md](../audits/security-step6-2026-10-06.md) (L1–L19) and
[ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md) (L1–L18; L1, L3 and L17 are
fixed, below).

## The gate

- [x] **`ci-local.sh`'s `eval` step runs extraction only.** It now runs `pnpm eval:assistant` and
  `pnpm eval:search` on the mock too, and requires every assistant case to pass and meaning fused
  in to find no less than keywords (f53e964; run once on 2026-10-07: 45/45, recall@10 0.613 →
  1.000 over 62 queries, the step 35 s). Still open: `eval/score.test.ts` on a quiet machine.
- [ ] **No step-6 e2e spec.** The plan's journeys (Louis asks and moves the drill, Talia's viewer
  sentence, Alfred in Arabic, a token over `/mcp`, OAuth consent, a webhook, semantic search, a
  lost location's thread) are covered by server and screen tests and were walked by hand in the
  screens review, not in `apps/web/e2e/`. **Proposed:** the combined final check, or 1.0's
  checklist.
- [ ] **No step-6 perf record.** Semantic search's 300 ms p95 (S6.4, Q13) and the assistant's turn
  overhead have no `test/perf` file. **Proposed:** with V5 on the 2 GB VM (step 8's device row).
- [ ] **The seed:** the e2e plan expects Louis to be a member of Garage; the `households` seed
  doesn't make him one (T14/T17 note).

## Maintainer checks (device rows, [2026-09-30-step6-devices.md](../spikes/2026-09-30-step6-devices.md))

- [ ] V13: real speech in English and Arabic (bare `ar` against `ar-EG`), a denied microphone, the
  panel and sheet by eye on a phone.
- [ ] V15: real MCP clients (Claude Desktop, claude.ai, ChatGPT) with CIMD; whether any needs DCR
  (off, plan Q8); a client that sends no `resource`.
- [ ] A real OIDC provider, including Better Auth's `?error=` codes on the sign-in page (inferred,
  not observed) and accepting an invite after a first OIDC sign-in.
- [ ] Shortcuts' action names on iPhone (unverified).
- [ ] A real embeddings model: the 0.65 cosine cutoff (an estimate) and `pnpm eval:search` with a
  real key; `pnpm eval:assistant` on a real provider.
- [x] §19's V13 and V15 rows say what the spikes and builds established; the real devices and
  clients stay maintainer checks (ca898be).

## Built partly, or not built

- [ ] **Retry at the learned output limit** (step-3 carry-in): `extractions.output_cap` exists
  (5ebc406) but the retry that uses it isn't built.
- [ ] **Linking an OIDC identity from Settings** (`/link-social` with re-authentication) has no UI.
- [ ] **`GET /assistant/threads` takes only `q`**: the web's list sends `locationId[]`, `not` and
  `from`/`to`, which the server ignores (the list standard's filters).
- [ ] **The CIMD fetch has no logger** (`AuthDeps` lacks one; security L9).
- [ ] **`ui/tick-box.tsx` duplicates the incident's TickBox.** Merge when either changes.
- [ ] **Expired and changed-since proposal cards** were checked on the mock only; the screens
  review saw a stale move card on the real server, not an expired one.
- [x] **Location webhooks never send `reminder.due`.** The scan now sends `webhook-fanout
  {occurrenceId}` for each new occurrence whose location has a hook taking it; the payload names
  the reminder (`evt_rem…`, entity type `reminder`, no field, kind or date), tested in
  `src/webhooks/webhooks.test.ts` (34e9d2c).
- [ ] **The web doesn't use two step-6 server routes:** reading a receipt again
  (`POST /purchases/:id/extract`, built in 9e49d00) has no button, and a thing's history has no
  `?kind=changes|ai|all` filter. Inferred from a search of `apps/web/src/api`, not from the
  screens.
- [x] **History labels** for `webhook.*` and `purchase.reextract`, with the instance's events,
  in five languages (ef18b65, c9e4b30).
- [ ] **Token REST writes have no Undo** in Recent changes (the tools' writes do; UI review L2).
  **Proposed:** decide whether REST writes made with a token get an undo window.

## Fixed in the finishing pass

- UI review L1: a question from a page with no location, refused for want of AI, says why under
  the field with "Connect AI in Settings", and Send waits for an edit; a refusal holds only for the
  context it came from (9cbe87d, d07e9eb).
- UI review L3: History and Activity name the token that made a change, through
  `kept.token_actor_names` (0105; 69a2150), recorded as D220.
- UI review L17: the rail's New location is a full 44 px target and focus scrolls rail entries
  clear of the sticky footer (f980e1a). Not re-run under axe: the second full audit confirms it.
