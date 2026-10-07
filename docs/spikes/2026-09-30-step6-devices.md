# Step 6: the device, public-URL and credentials checklist

Written 2026-09-30 (step-6 plan, Task 0). **Not run yet: every Result cell is empty.** The build
never waits for these rows. Each already ships its fallback (the "In use now" column), and a result
either confirms the preferred path or keeps the fallback (plan, "Needs the maintainer's devices").

**Nothing here is automated.** The rows that need a microphone exist because an automated test
must never open one. S6.6 found that Chrome's speech recogniser opens the real microphone even
with Chromium's fake-media flags
([2026-09-30-step6-dictation.md](2026-09-30-step6-dictation.md)).

## Before you start

1. **A public HTTPS URL for Kept** (Tailscale Funnel, or a tunnel you run), set as
   `KEPT_PUBLIC_URL`. Only the V15 rows need it. Everything else works on the LAN or tailnet over
   HTTPS (README → "Testing on a phone (HTTPS)").
2. **Seed:** `pnpm --filter @kept/server kept admin seed --scenario households`, then sign in as
   Ibrahim. For the assistant rows, add a Groq key in Settings → AI.
3. For V15, the exact steps and what to record are in
   [2026-09-30-step6-oauth-cimd.md](2026-09-30-step6-oauth-cimd.md) ("Maintainer check (V15): steps").

## Rows

| # | Check | How | Record | In use now | If it fails | Result |
|---|---|---|---|---|---|---|
| V13a | Dictation in the **installed iPhone app**, Arabic and English | Open Kept from the icon, open the assistant, tap the mic, say "وين الشنيور؟", then "Where is the drill?". Do the same in Capture's name field | Whether the mic appears; the text; the diagnostics probe's line (support, `lang`, last error) | The mic shows only where the API exists; typing always works | Hide the mic in the installed iPhone app when the probe says unsupported; Help says "use the keyboard's own dictation" | |
| V13b | The same **in Safari** on the iPhone | As V13a, in Safari | As V13a | As V13a | As V13a | |
| V13c | Dictation in **desktop Chrome**, real speech | Kept in Chrome on the Mac, the assistant's mic, the same two phrases, once with the interface in Arabic (`lang` `ar`) | The text; whether bare `ar` recognised Arabic, or it needed a region (`ar-EG`); the permission prompt and a "Block" | Same as V13a | If bare `ar` fails, T19 sets a region per language | |
| D213 | **Speak a list** (installed iPhone app) | "في المخزن عندي شنيور وسلم وعلبتين دهان", then "In the garage I have a drill, a ladder and two paint cans" | Whether one card lists **every** item with quantity and place; one Confirm; one Undo | T1/T13 per S6.3 finding 6 (`add_thing` takes a list) | S6.3 saw the model propose only the first item: record how many rows the card shows | |
| V15a | **claude.ai** connector over OAuth | Settings → Connectors → add Kept's `/mcp` URL → complete consent choosing one location | CIMD or DCR (Kept's log shows a `client_id` URL, or a `POST /oauth2/register`); the protocol (2026-07-28 or 2025); whether it sends `resource`; a tool call | Personal tokens and `/mcp` for any client that takes a bearer token; OAuth with CIMD works with the local fixture client | **Stop at DCR:** Q8 is the maintainer's decision | |
| V15b | **ChatGPT** connector over OAuth | ChatGPT's connector settings, the same URL | As V15a | As V15a | As V15a | |
| V15c | **Claude Desktop** with a personal token (story J9), and over OAuth if it offers it | Settings → Connections → new read token for Home; add it to Claude Desktop's MCP config; ask "Where is the drill?" | Connected or not; the protocol; revoking the token stops the next call | As V15a | Token only, where the client allows one | |
| — | The **iOS Shortcut** logs an odometer reading with a write token | Help's recipe | The reading appears, audited against the token | The route with token access; the Help recipe | Help says to log from Kept instead | |
| D207 | The **local embedding model** on a real 2 GB, 2-vCPU VM, amd64 and arm64 (D209) | After the memory fix in S6.5's plan changes: `harness.mjs` in a `--memory=2g --cpus=2` container on that VM, or the admin switch "Embeddings: local" once built | Added RSS, idle web+worker, first index of 10,000, query p95 | `provider` and `off` only (S6.5 failed on memory, +418 MB against 300: [2026-09-30-step6-local-embeddings.md](2026-09-30-step6-local-embeddings.md)) | `local` stays unavailable | |
| V36, S6.3 | The assistant on your Groq tier (8k TPM, 1k OTPM) answers a two-step question | Ask "Where is the drill, and who had it last?" as Louis | Whether it answers without "Waiting for Groq" | **S6.3 already passed this on the development key** (3 requests, ~3,000 input, ≤ 192 output tokens a turn). Recheck on the tier you run | `DEFAULT_MODELS.groq.assistant` stays `untested`; AI settings recommend another scope's chat model | |
| — | **Real keys** for OpenAI and Google embeddings (S6.4), and the assistant eval on two providers (T17) | Put the keys in `.env`; run `pnpm eval:search` and `pnpm eval:assistant` | The rate-limit header names; the real vector lengths; the dated eval reports | The mock embedder and mock assistant in CI | Only providers with keys get dated reports | |
