# Spike U1: the update check against GitHub's latest-release endpoint

Date: 2026-10-06. Step-8 plan, Task 0b (it feeds T11; D65, Q16). Result: **PASS.**
- `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`, unauthenticated, with
  `User-Agent: Kept`, answered **200** for restic/restic (`v0.19.1`) and **404** for a private
  repository and for a public repository with no releases. The two 404 bodies are byte-identical, so
  Kept can't tell them apart (and shouldn't try).
- **`guardedFetch` passes the request unchanged.** It was sent through Kept's own
  `apps/server/src/net/ssrf.ts` (not a copy) and got the same 200/404/404 answers. Two things T11
  must add itself: a timeout and a cap on the body it reads.
- The only header GitHub **requires** is a `User-Agent`. Without one: 403, "Request forbidden by
  administrative rules". `Accept` and `X-GitHub-Api-Version` are recommended. Neither identifies the
  instance, so D65's "nothing sent but the request" still holds.
- The unauthenticated limit is **60 requests an hour per IP address**. Other software on the same IP
  shares it: between my first and second call, `x-ratelimit-remaining` fell from 59 to 44. Only one
  of those 15 requests was mine; other clients on this machine's IP made the other 14.

Code: `docs/spikes/code/step8/updates/latest-release.spike.ts` imports `guardedFetch` from the server
source and runs with the server's `tsx` (its header says how). The plain-curl exchanges below were
made by hand on the same day.

## Sources (read 2026-10-06)

| What | Page |
|---|---|
| Endpoint, "latest" rule, 200/404, response fields | https://docs.github.com/en/rest/releases/releases ("Get the latest release", "List releases") |
| API versions, the default, 410 for an unsupported one | https://docs.github.com/en/rest/about-the-rest-api/api-versions |
| Rate limits, `x-ratelimit-*`, 403/429 | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10 |
| User-Agent required; 404 instead of 403 for private resources | https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api |
| Redirects (301/302/307), conditional requests, polling | https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api |

## What the docs say

- **Endpoint:** `GET /repos/{owner}/{repo}/releases/latest`. "The latest release is the most recent
  non-prerelease, non-draft release, sorted by the `created_at` attribute." So **drafts and
  prereleases are never returned**. Status codes: 200, 404.
- **Fields T11 uses** (all marked required in the response schema): `tag_name` (string), `html_url`
  (string, uri), `draft` (boolean), `prerelease` (boolean), `published_at` (string or **null**,
  date-time).
- **Prereleases** come only from `GET /repos/{owner}/{repo}/releases` (default `per_page` 30, max
  100). Drafts appear there only for users with push access, so an unauthenticated call never sees
  one.
- **API version header:** `X-GitHub-Api-Version`. Two versions are supported: `2026-03-10`, with no
  end date scheduled, and `2022-11-28`, which ends on 10 March 2028. Without the header GitHub uses
  `2022-11-28`. An unsupported version gets `410 Gone`. A version stays supported for 24 months
  after a newer one is released.
- **User-Agent:** "Requests without a valid `User-Agent` header will be rejected. You should use
  your username or the name of your application."
- **Private repositories:** "GitHub uses a `404 Not Found` response instead of a `403 Forbidden`
  response to avoid confirming the existence of private repositories."
- **Rate limit:** "60 requests per hour", "associated with the originating IP address". Headers:
  `x-ratelimit-limit`, `-remaining`, `-used`, `-reset` (UTC epoch seconds). Over the limit: "a `403`
  or `429` response, and the `x-ratelimit-remaining` header will be `0`"; don't retry before
  `x-ratelimit-reset`.
- **Conditional requests** (an `ETag` with `If-None-Match`) avoid the primary limit only "while
  correctly authorized with an `Authorization` header". Unauthenticated, a 304 still costs a
  request. I saw this too: `remaining` went 43 → 42 for a 304. So T11 gains nothing from ETags.
- **Redirects:** "A `301` status code indicates permanent redirection" (and 302/307 temporary).
  `guardedFetch` refuses every redirect (below). I assume, without having observed it, that a
  renamed repository's API URL answers 301.

## The recorded exchanges (synthetic: no token, public data only)

Headers sent: `User-Agent: Kept`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2026-03-10` (the first call used `2022-11-28`; the answer was the same).

| Request | Status | Relevant headers | Body (trimmed) |
|---|---|---|---|
| `restic/restic` | 200 | `x-ratelimit-limit: 60`, `-remaining: 59`, `-used: 1`, `-resource: core`, `-reset: 1791270740`; `cache-control: public, max-age=60, s-maxage=60`; `etag: W/"…"`; `x-github-api-version-selected` | 48,615 bytes; `{"tag_name":"v0.19.1","html_url":"https://github.com/restic/restic/releases/tag/v0.19.1","draft":false,"prerelease":false,"published_at":"2026-07-05T08:13:33Z", …}`, plus `assets`, `body` (the release notes), `author`, `immutable`, `reactions`, … |
| `ibrahimroshdy/kept` (private; the Dockerfile's default `SOURCE`) | 404 | `x-ratelimit-remaining: 44` | `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/releases/releases#get-the-latest-release","status":"404"}` |
| `step-security-bot/step-security_contributor-assistant-github-action` (public fork, `"private": false`; `GET …/releases?per_page=1` → 200 `[]`) | 404 | `x-ratelimit-remaining: 39` | the same 130-byte body as above |
| `restic/restic` with no `User-Agent` | 403 | — | `Request forbidden by administrative rules. Please make sure your request has a User-Agent header (…#user-agent-required). …` |
| `restic/restic` with `If-None-Match: <etag>` | 304 | `x-ratelimit-remaining: 42` (was 43) | — |

The no-release repository came from a real listing: it appeared in a web search for the StepSecurity
CLA fork (W1). `GET /repos/…` reported it public; its release list was empty.

**Through `guardedFetch`** (`latest-release.spike.ts`, `allowPrivate: false`,
`AbortSignal.timeout(10_000)`):

```
{"repo":"restic/restic","status":200,"ms":867,"bytes":48615,"rate":{"x-github-api-version-selected":"2026-03-10","x-ratelimit-limit":"60","x-ratelimit-remaining":"38",…},"body":{"tag_name":"v0.19.1","html_url":"https://github.com/restic/restic/releases/tag/v0.19.1","draft":false,"prerelease":false,"published_at":"2026-07-05T08:13:33Z"}}
{"repo":"ibrahimroshdy/kept","status":404,"ms":236,"bytes":130,…,"body":{"message":"Not Found",…}}
{"repo":"step-security-bot/step-security_contributor-assistant-github-action","status":404,"ms":69,"bytes":130,…}
```

## Does `guardedFetch` pass it unchanged? Yes. What T11 must know (`apps/server/src/net/ssrf.ts`)

- **Headers pass through** in `init`: line 125–129 spreads `init` into undici's `fetch` and overrides
  only `redirect` and `dispatcher`. But line 120 keeps **only the URL** of a `Request` object, so
  headers on a `Request` are lost. T11 must pass a string URL plus `init.headers`.
- **DNS/IP rules:** lines 116–118 use an undici `Agent` whose `connect.lookup` (lines 89–101) refuses
  every address in `PRIVATE_RANGES` (lines 30–63), and also a name that resolves to nothing.
  `api.github.com` resolved to public addresses, so it passed. The update check is a fixed public
  host, so T11 calls `guardedFetch({ allowPrivate: false })` whatever `ssrf_allow_private` says. The
  setting exists for LAN Ollama and has no bearing here. T11's tests use the `resolve` stub (line
  115) or `allowPrivate: true` against the local stub server.
- **Redirects are refused:** line 127, `redirect: 'error'`. A 301 (for example a renamed repository)
  throws a fetch `TypeError` instead of being followed. T11 records it as `error` and never follows
  it: following would let a GitHub-side redirect pick the host.
- **No timeout:** nothing in `guardedFetch` sets one. T11 passes `signal: AbortSignal.timeout(…)`
  (10 s in the spike).
- **No size cap:** the body is whatever GitHub sends. restic's was 48,615 bytes, mostly release
  notes. T11 reads at most a fixed cap (proposal: 1 MiB) and keeps only the five fields.

## The source URL (Q16): where it comes from and how to read owner/repo

`KEPT_SOURCE_URL` exists:
- `Dockerfile` lines 83–100: `ARG SOURCE=https://github.com/ibrahimroshdy/kept`, the label
  `org.opencontainers.image.source="${SOURCE}"`, and
  `ENV KEPT_SOURCE_URL="${SOURCE}${REVISION:+/tree/${REVISION}}"`. So an official image carries
  `https://github.com/ibrahimroshdy/kept/tree/<commit>`, or the bare repository URL when no
  revision was given.
- `apps/server/src/config/env.ts` line 138: `KEPT_SOURCE_URL: httpUrl().optional()` (http or https).
  Lines 852–856 refuse to boot in production without it (D147).
- `compose.yaml` lines 123–124 leave it to the image default. A fork sets its own.
- `scripts/ci-local.sh` lines 238–239 use `git remote get-url origin` with `.git` stripped.
- `env.test.ts` line 309 uses `https://github.com/x/y@abc123`, an `@<rev>` form.

**Derivation rule for T11** (proposed; the character sets are my assumption, not taken from GitHub
documentation):
1. Parse with `new URL()`. Continue only if the protocol is `https:` and the hostname is exactly
   `github.com`. Anything else means no request and a stored state of `not_github`.
2. Take the first two path segments as owner and repo. Strip a trailing `.git` from the repo, and
   anything from the first `@`. Ignore the rest of the path (`/tree/<rev>`).
3. Accept the owner only if it matches `^[A-Za-z0-9-]+$` and the repo only if it matches
   `^[A-Za-z0-9._-]+$`. Otherwise, no request.
4. Build the request URL from those two values only:
   `https://api.github.com/repos/${owner}/${repo}/releases/latest`.

**Consequence while the repository is private:** every instance running the official image gets
404 → `not_found` until the repository is public (D199). T11's UI wording should cover that case
("No published release found for <repo>"), not call it an error.

## Changes to the plan

- **T11, headers:** `User-Agent: Kept` is the only required header. Also send
  `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`; neither carries
  instance data. Pinning `2026-03-10` avoids 2022-11-28's end of support in March 2028. A 410 is
  stored as `error`.
- **T11, outcomes:** 200 → compare `tag_name` (strip a leading `v`) with the running version. 404 →
  `not_found` (private, no release, or gone; indistinguishable by design). 403 or 429 with
  `x-ratelimit-remaining: 0` → `rate_limited`, with no retry before the next daily run. A redirect
  `TypeError` or any other failure → `error`. `published_at` may be null.
- **T11, prereleases:** `/releases/latest` never returns one. "Prereleases only when the running
  version is one" therefore means: when the running version is a prerelease, call
  `GET /repos/{owner}/{repo}/releases?per_page=10` instead, and take the newest entry that isn't a
  draft. Otherwise use `/latest`.
- **T11, guardedFetch use:** pass a string URL and `init.headers` (never a `Request`),
  `allowPrivate: false`, an `AbortSignal.timeout`, and a body-size cap. No ETag logic.
- **T11, source URL:** the derivation rule above, with a `not_github` state that sends nothing.
- **T19 docs:** say the check shares GitHub's 60-an-hour unauthenticated limit with everything else
  on the server's IP, and that it fails quietly if that is exhausted.
