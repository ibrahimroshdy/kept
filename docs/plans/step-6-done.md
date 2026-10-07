# Step 6: the definition of done, item by item

Written on 2026-10-07 in the finishing pass for steps 6–8, from the coordinator's notes, the
agents' commits and the two reviews: the security review
([security-step6-2026-10-06.md](../audits/security-step6-2026-10-06.md)) and the screens review
([ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md)). It takes each item of
"Definition of done for step 6" ([2026-09-30-step-6-assistant-mcp.md](2026-09-30-step-6-assistant-mcp.md))
and marks it **met**, **met with a note**, **not met**, **pending final check** or **maintainer
check pending**. A separate final-check agent runs the combined gate for steps 5–8 next; nothing
here claims that gate passed. What is still open is in [step-6-carryover.md](step-6-carryover.md).

**Summary:** the build is in (tokens, MCP, OAuth connectors, the assistant, webhooks, OIDC,
semantic search, evaluation) and both reviews are done with every high and medium finding fixed.
The one-run gate is pending the final check, and two of its parts are not built yet: an
assistant and search step in `ci-local.sh`, and a step-6 e2e spec. The fresh-install walkthrough
is a maintainer check.

## 1. `bash scripts/ci-local.sh` exits 0, with `drift`, `licences`, `perf`, `eval` (extraction, assistant, search on the mock), the MCP contract suite and `e2e`: **met in the final check, except the release dry run (disk)**

- **Final check (2026-10-07).** The gate at 825c4c5, as `KEPT_TEST_RESTIC=1 KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh`
(restic 0.19.1 darwin, checked against the spike's SHA-256; no smoke override), run from the top
and re-run `--from` the step that failed after each fix, in the main tree with no other agent on
the machine: install 1 s, lint 6 s, catalogues 3 s, typecheck 11 s, compose 1 s, test 511 s
(5,868 tests), drift 3 s, licences 2 s, attribution 1 s, docs 13 s, helm 1 s, prod-boot 17 s,
eval 36 s, portability 22 s, backup 135 s (the real restic), perf 554 s, e2e 633 s (76 passed,
42 one-project skips, the update spec 1), images 252 s: **all ok**. `release-dry-run`: built,
pushed by digest and smoked arm64 (PASS), then **stopped by hand at 3.3 GB free** (the agent
rules' 5 GB floor; it needs 15 GB, `KEPT_RELEASE_MIN_FREE_GB`); not completed. What failed on the
way and was fixed: 7a1c6a4, 900f425, 3062671, 9c1a70a, 95ad483, f6a925e, a7faf33, 825c4c5.
- **Since closed:** `eval` runs the assistant (46/46 on the mock) and search evaluations (f53e964);
  `eval/assistant/score.test.ts` passed alone on the quiet machine (9 tests, 23 s) once its floor of
  two steps a case was corrected to one (a turn ends at its card; 3062671). `e2e/step6.spec.ts`
  (18c8dd0), on an HTTPS instance with the AI mock's scripted cases: the move card, Confirm, Undo; a
  spoken list through a stub recogniser as one card of three; a token made in Connections reading
  the API and `/mcp` (tools/list, where_is), revoked, then 401 on both; axe on each page. Perf:
  search p95 18.7 ms by keyword and 261.8 ms with meaning at 10,000 embedded things (limit 300),
  `where_is` 30.1 ms ([docs/perf/2026-10-07-final.md](../perf/2026-10-07-final.md)).

As written before the final check:
- **Not met: `eval` runs extraction only.** `pnpm eval:assistant` and `pnpm eval:search` exist,
  with mock runs and dated reports (720a787), but `ci-local.sh`'s `eval` step doesn't call them
  (step 6 notes, T26). The harness's `score.test.ts` timed out at load 40–50 and wasn't confirmed
  on a quiet machine.
- **Not met: no step-6 e2e spec.** `apps/web/e2e/` has specs for steps 2–5 only. The screens were
  driven by hand in headless Playwright on a real server for the screens review (assistant sheet
  and panel, dictation with a stub recogniser, the D213 card, Connections, consent, webhooks,
  semantic notes), which is evidence but not a repeatable gate.
- **The MCP contract suite** runs in the `test` step (`packages/mcp` and `src/mcp/mcp.test.ts`).
- **Web suite at HEAD before this pass:** 7 failures in 6 files, all tests that hadn't followed
  what was built; fixed in 799c256. The registry test's two failures (the hourly update check,
  step 6's pruned tables) were fixed in a9b459f, and the route catalogue's two in 7420241.

## 2. The leak test covers every new table and function; a token never sees outside its locations; threads are invisible to admins; kept_app reads no vector, token hash or webhook secret: **met**

- Step 6's fixtures are `test/leak-assistant.ts` (tokens, the assistant, embeddings, webhooks for
  each tenant), with the token principal's probes in `test/leak.test.ts`.
- The security review walked all 100 `SECURITY DEFINER` doors granted to kept_app for token
  principals (its L10) and fixed the five mediums with tests (7a3769b); its five schema items
  landed as 0098–0102 (29550e5, 371039f, fcea790).
- The final pass added `kept.token_actor_names` (0105) with a viewer probe that reads only tokens
  seen acting in a location the caller sees (69a2150). The leak test passed after it (65 tests).
- kept_app can't select `api_tokens.hash` (0070's column grant); webhook secrets are sealed and
  write-only (0077–0078); vectors are read only through the semantic doors (0076).

## 3. Every model call and embedding goes through `ai/call.ts`, one provider request per call, one ledger row each, nothing of the conversation in `llm_calls`; caps pause, provider limits wait: **met**

- `callModel` is the one door for tool calling and embeddings, one request per call (6f83aa1);
  the assistant loop runs one model step per call (T8, 30f1119).
- `llm_calls.usage_estimated` marks a provider that reports no tokens (824c768).
- A viewer's turn is paid by the location's account key, with the shared breaker (a8c282e,
  recorded as D218).
- The "no question, answer, tool argument or vector in `llm_calls`" test is in the assistant's
  server tests (T8); not re-run in this pass.

## 4. The fresh-install walkthrough (`households`): **maintainer check pending**

- Louis's linked answer, the move card and Undo; Talia's viewer sentence; Alfred in Arabic; a
  spoken list as one card: seen on a real server with the AI mock in the screens review, and in
  `src/test/screens/assistant.test.tsx` on the web mock.
- A read-only token used over `/mcp`, and revoking it: `src/mcp/mcp.test.ts`,
  `src/tokens/tokens.test.ts`. Real clients (Claude Desktop, claude.ai, ChatGPT) are device row
  V15.
- OAuth with consent to one location: `src/oauth/oauth.test.ts`; the consent
  page was reviewed with its view intercepted (no public CIMD client here; UI review L11).
- A signed, value-free `thing.moved` webhook: `src/webhooks/webhooks.test.ts`.
- "The thing for the TV" finds the HDMI cable: the mock's concept lexicon and the search eval on
  the mock; a real embeddings model and the 0.65 cutoff are the maintainer's real-provider run.
- Louis losing Home redacts his thread's Home results: the redaction tests (0073, 0102).
- **Not run on a fresh `docker compose up`.** That is the maintainer's walkthrough.

## 5. With no AI provider, everything but the assistant and semantic search works: **met with a note**

- Tokens, MCP, webhooks and OIDC carry no AI dependency (their tests run without a provider).
- From a page with no location, a question refused for want of AI now says why and offers
  "Connect AI in Settings" (UI review L1, 9cbe87d).

## 6. The device checklist filled in or each row naming its fallback; §19 updated; carry-over written: **met with a note**

- [docs/spikes/2026-09-30-step6-devices.md](../spikes/2026-09-30-step6-devices.md): every row is
  a maintainer check pending, each with the fallback in use (real speech in English and Arabic,
  mic denial, real MCP clients with CIMD or DCR, a real OIDC provider).
- **§19 not updated** for V13 and V15 in this pass: both stay "Build step 6", unrun.
- [step-6-carryover.md](step-6-carryover.md) is written.

## Decisions recorded

D215–D220 in the product design's decision log (2026-10-07): Full width fills tabbed settings, the
assistant panel by width, what D181's "export" covers, a viewer's assistant paid by the account,
Run now one at a time, token names in history. The plan's own "Decided while building" lists hold
the rest.
