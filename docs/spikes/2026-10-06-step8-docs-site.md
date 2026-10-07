# Spike D1: the docs site (Starlight)

Date: 2026-10-06. Step-8 plan, Task 0b (it feeds T18, T19 and T20; D102, D199, Q19). Result: **PASS.**
- A scratch Starlight site with **five locales** (`en` at the root, `ar` right to left, `fr`, `de`,
  `it` falling back to English), **Pagefind** search, the **API reference rendered from Kept's own
  OpenAPI JSON** (all 333 operations), and **starlight-links-validator** builds with the network
  blocked: exit 0, 350 pages, no network attempt.
- The Arabic page is `<html lang="ar" dir="rtl">` with Starlight's Arabic UI strings ("تخطَّ إلى
  المحتوى", "ابحث", "القائمة", "على هذه الصفحة", "اختر سمة", "اختر لغة", "التالي", …).
- `fr`, `de` and `it` pages are the English text under each language's own notice ("Ce contenu n’est
  pas encore disponible dans votre langue.", "Dieser Inhalt ist noch nicht in deiner Sprache
  verfügbar.", "Questi contenuti non sono ancora disponibili nella tua lingua.").
- A deliberately broken link **fails the build** (exit 1, file and line reported); fixed, it passes.
- **The OpenAPI JSON needs no database and no dev server:** `buildApp()` with pools pointing at a
  closed port, then `app.inject()`, made **zero** connection attempts. T18 can take this route.

Code: `docs/spikes/code/step8/docs-site/`:
- `dump-openapi.ts`: Kept's OpenAPI JSON from `buildApp()` in-process, counting database attempts.
- `site/`: the Astro project (`astro.config.mjs`, `src/content.config.ts`, six Markdown pages).
- `net-guard.mjs`: a `--import` preload that records (`NET_GUARD=log`) or refuses
  (`NET_GUARD=block`) every DNS lookup, socket and `fetch` to a non-loopback host.
- `results-2026-10-06.json`: every number below.
- `package.json` + `package-lock.json` (npm, outside the workspace).

## Versions (`npm view` on 2026-10-06)

| Package | Version | Licence | Peers / engines | Published |
|---|---|---|---|---|
| `astro` | 7.3.5 | MIT | engines `node >=22.12.0`; peer `@astrojs/markdown-remark ^7.3.0` | 2026-09-24 |
| `@astrojs/starlight` | 0.42.5 | MIT | peers `astro ^7.2.10`, `@astrojs/markdown-remark ^7.3.0`; deps `pagefind ^1.5.2`, `@pagefind/default-ui ^1.3.0`, `@astrojs/sitemap`, `@astrojs/mdx`, `astro-expressive-code` | 2026-10-01 |
| `@astrojs/markdown-remark` | 7.3.1 | MIT | (astro's and Starlight's peer: list it explicitly) | |
| `starlight-links-validator` | 0.26.0 | MIT | engines `node >=22.12.0`; peers `@astrojs/starlight >=0.42.0`, `astro >=7.2.10` | 2026-09-02 |
| `starlight-openapi` | 0.26.3 | MIT | peers `astro >=7.0.2`, `@astrojs/starlight >=0.41.0`, `@astrojs/markdown-satteri >=0.3.2` | 2026-09-28 |
| `@astrojs/markdown-satteri` | 0.4.2 | MIT | (starlight-openapi's peer: list it explicitly) | |
| `pagefind`, `@pagefind/default-ui` | 1.5.2 (resolved) | MIT | | |

Both plugins are the ones Starlight's own plugin showcase lists for these jobs
(<https://starlight.astro.build/resources/plugins/>, read 2026-10-06): "Check for broken links in your
Starlight pages" (HiDeoo/starlight-links-validator) and "Create documentation pages from
OpenAPI/Swagger specifications" (HiDeoo/starlight-openapi).

**Against Node 24 and the workspace:** every engine range admits Node 24 (ran on 24.21.0). Astro
7.3.5 depends on `vite ^8.0.13` (8.3.2 resolved here) while `apps/web` pins `vite 8.3.1`, and on
`zod ^4.5.4` (the workspace pins 4.6.5; within range). Inferred, not tried in the workspace: pnpm
keeps a second Vite for `apps/docs` unless the web pin moves to 8.3.2. Starlight 0.42.5 was published
2026-10-01, more than a day before this spike, so a release-age gate of a day or so would not hold
it back (the workspace has a `minimumReleaseAgeExclude` list; its age setting itself wasn't checked).

**Licences of the whole tree** (434 packages, read from each `package.json`): 387 MIT, 14 ISC, 10
BSD-2-Clause, 7 Apache-2.0, 6 BSD-3-Clause, 3 BlueOak-1.0.0, 2 CC0-1.0, 1 Python-2.0, plus
`lightningcss` (MPL-2.0, 2 packages), `@img/sharp-libvips-*` (LGPL-3.0-or-later, sharp is Astro's
optional dependency) and `pause-stream` (MIT/Apache-2.0). The workspace already carries `sharp` and
libvips, and D187 already lists LGPL. This is a devDependency tree (the output is static files),
so D187's looser devDependency list applies.

**Install:** 237 MB of `node_modules`, 181 s with npm (cold, on a busy machine). npm 11 reported
esbuild's postinstall as not yet allowed and skipped it; the builds worked anyway (the workspace's
`allowBuilds` already has `esbuild: true`).

## The OpenAPI JSON without a database

`dump-openapi.ts` builds the app as the server does (`buildApp()`, `apps/server/src/http/app.ts`),
with `createPools()` pointing all three pools at `127.0.0.1:1`, and asks for `OPENAPI_PATH` through
`app.inject()`:

| | Result |
|---|---|
| Status, version | 200, OpenAPI 3.1.0, `info.version` `0.0.0-dev` |
| Size | 254 paths, 333 operations; 1,235,976 bytes compact, 3.6 MB pretty-printed |
| Database attempts | **0** with `headers: {host: 'kept.test'}` (the host of `KEPT_PUBLIC_URL`) |
| Time | 0.5–1.6 s, build to response |

Without the `Host` header, `inject()` sends `localhost:80`, and the former-hostnames hook
(`labels/former-hosts.ts`) tries one `instance_settings` read. It fails, the hook catches it, and
the response is still 200. Setting `Host` to the public URL's host avoids even that attempt.

## The site

`site/astro.config.mjs`: `defaultLocale: 'root'`, `locales` `root` (English, `lang: 'en'`), `ar`
(`dir: 'rtl'`), `fr`, `de`, `it`; `starlightLinksValidator({errorOnFallbackPages: false, exclude:
['/api/', '/api/**']})`; `starlightOpenAPI([{base: 'api', schema: './openapi/kept.json'}])` with
`openAPISidebarGroups` in the sidebar. Content: three English pages and the same three in Arabic,
nothing in `fr`/`de`/`it`. Config shapes were read from Starlight's i18n and manual-setup guides
(<https://starlight.astro.build/guides/i18n/>, <https://starlight.astro.build/manual-setup/>) and
from the installed plugins' sources (`starlight-openapi/libs/schemas/schema.ts`,
`starlight-links-validator/libs/config.ts`).

**Build runs** (the machine's load average was 21–46 from other agents throughout, so times swing
3×):

| Run | Network | Exit | Wall | Pages |
|---|---|---|---|---|
| broken link, with the API | recorded | **1** | 42 s | 350 |
| fixed, with the API | **blocked** | 0 | 56 s (Astro: 46.4 s) | 350 |
| fixed, with the API, again | blocked | 0 | 182 s (Astro: 152 s; load 36) | 350 |
| prose only (`SPIKE_NO_API=1`) | blocked | 0 | 10–81 s (Astro: 3.2–47 s) | 16 |

**The failing link check** (the CLI report, condensed):

```
[ERROR] [starlight-links-validator] Links validation failed.
  ╭─ index.md
7 | /api/                      ╰── invalid link
  ╭─ guides/backups.md
11 | /guides/restore/          ╰── invalid link
· Found 2 invalid links in 2 files. ·
```

`/guides/restore/` was the deliberate one. Removing it made the next build print "All internal
links are valid." and exit 0.

**Output size:** 44.6 MB, 749 files, with the API reference; **40 MB of it is the API reference**
(334 pages, ~120 KB each), Pagefind 2.5 MB, JS and CSS 228 KB. Without the API: 1.6 MB (Pagefind
1.0 MB). Pagefind builds one index per language (`en`, `ar`, `fr`, `de`, `it`: 3 pages each in the
prose build; fallback pages are indexed under their own language, in English).

**Offline:** the build fetches nothing it needs. The only network call is **Astro's telemetry**
(`fetch https://telemetry.astro.build/api/v1/record`), made when telemetry is on; blocked, the build
still exits 0. `ASTRO_TELEMETRY_DISABLED=1` (read in `@astrojs/telemetry` 3.3.3's source) stops it.
The built HTML loads no remote script, stylesheet or font; its only absolute URLs are its own
`site` (canonical and `hreflang` links).

## Findings for the plan

1. **The API reference comes from `buildApp()` with no database** (T18's open condition). The
   script: pools at a closed port, `inject` with `Host` set to the public URL's host. The `docs`
   step needs no dev server and no Postgres.
2. **`errorOnFallbackPages: false` is required.** Its default is `true`, which errors on every link
   into a fallback page, and `fr`/`de`/`it` are fallback pages by design (Q19).
3. **The API pages are injected routes the link validator can't see:** a Markdown link to `/api/`
   fails the check. `exclude: ['/api/', '/api/**']` is the fix; links inside the generated pages
   aren't checked.
4. **starlight-openapi writes one page per operation:** 334 pages, ~90% of the output and most of
   the build time. They exist only at the root locale (`/api/…`); Arabic and the other locales link
   to the English reference. The JSON compact is 1.2 MB.
5. **Pagefind indexes the reference too** (2.5 MB index against 1.0 MB without it).
6. **Telemetry:** set `ASTRO_TELEMETRY_DISABLED=1` in `docs:build`, `docs:dev` and the `docs` CI
   step. It isn't needed for the build to pass offline, but without it every build calls out.
7. **Starlight ≥ 0.39 config shape:** a sidebar group is `{label, items: [{autogenerate:
   {directory}}]}`; `{label, autogenerate}` is refused at startup.
8. **Name both peers explicitly** in `apps/docs/package.json`: `@astrojs/markdown-remark` (Astro and
   Starlight) and `@astrojs/markdown-satteri` (starlight-openapi).
9. The links validator runs only on `astro build` (its `config:setup` returns early otherwise), so
   `docs:dev` doesn't check links.

## Changes to the plan

- **T18:** `scripts/openapi.ts` uses `buildApp()` without a database (finding 1); drop the
  dev-server fallback.
- **T18:** the API reference's JSON is generated at build time into a git-ignored path rather than
  committed: it needs no database, so a drift check on a 1.2 MB file adds nothing. The configuration
  reference (`reference/configuration.md`) keeps its committed copy and drift check. *(Proposal; the
  plan's wording "generated pages, committed" still works if the coordinator prefers it.)*
- **T18:** the Starlight config carries `errorOnFallbackPages: false`, `exclude` for `/api/**`, and
  `ASTRO_TELEMETRY_DISABLED=1` in the scripts (findings 2, 3, 6).
- **T18 pins:** `astro` 7.3.5, `@astrojs/starlight` 0.42.5, `@astrojs/markdown-remark` 7.3.1,
  `starlight-links-validator` 0.26.0, `starlight-openapi` 0.26.3, `@astrojs/markdown-satteri` 0.4.2.
- **T20/D199:** the published site is ~45 MB with the reference (GitHub Pages serves it as-is).

## Rerun

From the repo root, Node 24 on the `PATH`:

```sh
# 1. The OpenAPI JSON (no database, no server):
mkdir -p docs/spikes/code/step8/docs-site/site/openapi
pnpm --filter @kept/server exec tsx ../../docs/spikes/code/step8/docs-site/dump-openapi.ts \
  ../../docs/spikes/code/step8/docs-site/site/openapi/kept.json
# 2. The site, network blocked:
cd docs/spikes/code/step8/docs-site && npm ci
ASTRO_TELEMETRY_DISABLED=1 NODE_OPTIONS="--import ./net-guard.mjs" NET_GUARD=block npx astro build --root site
# A broken link: add [x](/guides/restore/) to site/src/content/docs/guides/backups.md and build again (exit 1).
rm -rf site/dist site/.astro site/openapi
```
