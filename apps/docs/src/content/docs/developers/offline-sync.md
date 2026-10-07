---
title: Offline and sync
description: What the phone keeps offline, how queued changes reach the server, and how the server answers each one.
---

Kept is not a two-way sync app. The phone holds a **read-only copy** of the places and things you
can see, and a **queue** of a few kinds of change it can make without signal: capture, move, a
meter reading, claiming a label, marking something seen or not here, a new area, a box check.
Everything else needs a connection. Full two-way offline sync was rejected in
[D17](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md)
as permanent complexity in every table and endpoint.

The contracts are in the engineering spec:
[§2.2 offline snapshot, §2.3 queue item](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)
and §7.4 sync protocol. The wire types live once, in
[`packages/shared/src/sync.ts`](https://github.com/ibrahimroshdy/kept/blob/main/packages/shared/src/sync.ts),
and both sides parse with them.

## Where the code is

| Side | Path | What it does |
|---|---|---|
| Web | `apps/web/src/sw.ts`, `apps/web/src/pwa/sw-routes.ts` | The Serwist service worker |
| Web | `apps/web/src/offline/db.ts` | The Dexie database, one per user (`kept-<userId>`) |
| Web | `apps/web/src/offline/queue.ts` | The queue's state machine and batching, as pure functions |
| Web | `apps/web/src/offline/sync-engine.ts` | Runs uploads, ops, then the snapshot pull |
| Web | `apps/web/src/offline/uploader.ts`, `snapshot.ts`, `thumbs.ts`, `wipe.ts` | Files, the pull, the thumbnail cache, what goes on sign-out or a 401 |
| Server | `apps/server/src/sync/routes.ts` | `GET /api/v1/sync/snapshot` |
| Server | `apps/server/src/sync/ops.ts`, `sync/handlers/` | `POST /api/v1/sync/ops`, one handler per op kind |
| Server | `apps/server/src/sync/cursor.ts` | The signed, opaque sync cursor |
| Server | `apps/server/src/sync/extras.ts` | `GET /api/v1/sync/extras`: "keep this location available offline" |

## What the service worker caches

The service worker is built with [Serwist](https://serwist.pages.dev/) by `@serwist/vite`
(chosen in D101; proven in the
[step-3 Serwist spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-26-step3-serwist.md)).
`apps/web/vite.config.ts` builds `src/sw.ts` to `dist/sw.js` with the precache manifest injected.

- **Precached:** the shell (`index.html`, JS, CSS), the fonts Kept renders, the icons and the
  barcode scanner's wasm, so the app opens, captures and scans offline.
- **Cached on first use** (CacheFirst): lucide's icon chunks (`kept-icons`), the Lingui
  catalogue in use (`kept-locales`), and the on-demand screens under `assets/household/`
  (`kept-household`).
- **Never cached:** `/api` and `/f` are NetworkOnly. Authenticated responses never go into the
  Cache API (D181), because it isn't per user and isn't wiped with the session.
- **Updates wait** (D148): `skipWaiting` is off. The page sends `SKIP_WAITING` only when the person
  taps Reload and nothing is uploading (`pwa/update-prompt.tsx`).

`apps/web/scripts/check-bundle.mjs` runs after every `vite build` and fails it when the precache
is over **3 MiB without the wasm** (`PRECACHE_BUDGET`), the wasm is over `WASM_BUDGET`, or an
icon chunk, a catalogue or anything authenticated slipped into the precache.

## Screens that need a connection

The precache holds only what the offline promise needs: the shell, Home, browsing places and
things, capture, the inbox, scan and old labels, search, and sync. A new screen that reads only
the server loads on demand instead:

1. Add its route's `?tsr-split=component` chunk to `HOUSEHOLD_ROUTES` in
   `apps/web/vite.config.ts` (and any chunk only it imports to `HOUSEHOLD_SHARED`).
2. Give the route an `errorComponent` that says "Needs a connection" offline
   (`apps/web/src/components/on-demand-route-error.tsx`, or a layout's, which covers its children).
3. List its route id in `COMPONENT_ONLY_ROUTES`, so the error screen stays precached without a
   chunk of its own.

Don't raise `PRECACHE_BUDGET` to fit a server-only screen.

## The snapshot on the phone

The phone keeps, per location the person is a member of: places, things (name, short code, type,
place or container, quantity, aliases, lifecycle, last seen, cover photo id, meters with their
latest reading, open loan), short IDs and legacy codes. Never secrets or people's contact details.
Money and documents come only for a location the device keeps offline, behind the app lock
(D159, D181), through `GET /api/v1/sync/extras`.

| Limit | Value | Where |
|---|---|---|
| Things per person in the snapshot | 20,000; past it the page says `truncated` | `SYNC_LIMITS.snapshotThings` |
| Snapshot page | 1,000 rows by default, 2,000 at most | `SYNC_LIMITS.snapshotPage*` |
| Thumbnail cache | 200 MB, least recently used out | `THUMB_LIMIT_BYTES`, `offline/thumbs.ts` |
| "Keep offline" per device | 250 MB; one file at most 25 MB | `KEEP_OFFLINE` in `packages/shared/src/ops.ts` |

Thumbnails are stored as bytes in the per-user database, never in the Cache API.

**The pull.** The first sync sends no cursor and gets everything. Each page's `nextCursor` goes
back as `cursor` until a page says `complete`; the last one is kept, so the next sync gets only
what changed. Pages also carry `removed` (tombstones from `sync_tombstones`: purges, merges, moves
out of a location) and `revokedLocationIds`, which the phone deletes at once (D156).

**The cursor** is opaque to the phone: base64url JSON with an HMAC-SHA256 signature keyed from
`KEPT_AUTH_SECRET`. It holds an xid watermark per location: every synced row carries `change_xid`
(the transaction that last changed it), and a pass reads rows at or after the watermark, so a
transaction that commits late is never skipped. A cursor that doesn't verify (for example after the
secret changed) is a 400 `validation`; the phone drops its copy, never its queue, and pulls a full
pass.

## The queue and how it replays

A queue item ([§2.3](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md))
carries `clientVersion`, `payloadVersion`, a client-made UUIDv7 `clientId`, an `idempotencyKey`,
the `op`, `takenAt` (device time), `locationId`, an optional `dependsOn` list and the `payload`.
The op kinds are `OP_KINDS`: `create_thing`, `move`, `log_reading`, `claim_label`, `mark_seen`,
`not_here`, `create_area`, `box_check`.

The sync engine runs on app open, when the page becomes visible, when the network comes back,
after each enqueue, and every 60 s while visible. Never in the background: Safari has no
Background Sync, so on iOS the queue uploads only while Kept is open. One run at a time across
tabs, through `navigator.locks`. Each run:

1. upgrades payloads an older build queued (D148);
2. uploads each entry's files with `PUT /api/v1/files/:fileId`, idempotent on id and SHA-256;
3. sends ops with `POST /api/v1/sync/ops`, at most 50 a batch, strictly in queue order, stopping
   at the first entry whose files aren't up yet;
4. pulls the snapshot until complete.

<figure class="kd-diagram">
<svg viewBox="0 0 760 300" role="img" aria-labelledby="d-sync-t" dir="ltr">
<title id="d-sync-t">One sync run: files, then ops, then the snapshot</title>
<defs><marker id="d-sync-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kd-head" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="kd-zone" x="10" y="10" width="240" height="282" rx="8"/>
<text class="kd-zone-t" x="22" y="30">Phone, IndexedDB per user</text>
<rect class="kd-box" x="30" y="44" width="200" height="56" rx="6"/>
<text class="kd-t" x="130" y="68" text-anchor="middle">Offline queue</text>
<text class="kd-t2" x="130" y="86" text-anchor="middle">ops and files, in order</text>
<rect class="kd-box" x="30" y="130" width="200" height="56" rx="6"/>
<text class="kd-t" x="130" y="154" text-anchor="middle">Sync engine</text>
<text class="kd-t2" x="130" y="172" text-anchor="middle">open, focus, online, 60 s</text>
<rect class="kd-box kd-sunken" x="30" y="220" width="200" height="56" rx="6"/>
<text class="kd-t" x="130" y="244" text-anchor="middle">Snapshot copy</text>
<text class="kd-t2" x="130" y="262" text-anchor="middle">places, things, codes</text>
<path class="kd-edge" d="M130 100V130" marker-end="url(#d-sync-a)"/>
<rect class="kd-zone" x="280" y="10" width="470" height="282" rx="8"/>
<text class="kd-zone-t" x="292" y="30">Kept server</text>
<rect class="kd-box" x="300" y="44" width="230" height="46" rx="6"/>
<text class="kd-t kd-mono" x="415" y="64" text-anchor="middle">PUT /api/v1/files/:fileId</text>
<text class="kd-t2" x="415" y="81" text-anchor="middle">1. files, replay-safe</text>
<rect class="kd-box" x="300" y="135" width="230" height="46" rx="6"/>
<text class="kd-t kd-mono" x="415" y="155" text-anchor="middle">POST /api/v1/sync/ops</text>
<text class="kd-t2" x="415" y="172" text-anchor="middle">2. up to 50 ops, one result each</text>
<rect class="kd-box" x="300" y="225" width="230" height="46" rx="6"/>
<text class="kd-t kd-mono" x="415" y="245" text-anchor="middle">GET /api/v1/sync/snapshot</text>
<text class="kd-t2" x="415" y="262" text-anchor="middle">3. changes since the cursor</text>
<rect class="kd-box kd-accent" x="560" y="108" width="174" height="100" rx="6"/>
<text class="kd-t kd-on-accent" x="647" y="132" text-anchor="middle">One tx per op</text>
<text class="kd-t2 kd-on-accent" x="647" y="154" text-anchor="middle">ledger, version, role</text>
<text class="kd-t2 kd-on-accent" x="647" y="172" text-anchor="middle">handler, audit</text>
<text class="kd-t2 kd-on-accent" x="647" y="190" text-anchor="middle">applied / review / dropped</text>
<path class="kd-edge" d="M230 146H262V67H300" marker-end="url(#d-sync-a)"/>
<path class="kd-edge" d="M230 158H300" marker-start="url(#d-sync-a)" marker-end="url(#d-sync-a)"/>
<path class="kd-edge" d="M530 158H560" marker-start="url(#d-sync-a)" marker-end="url(#d-sync-a)"/>
<path class="kd-edge kd-dashed" d="M300 248H230" marker-end="url(#d-sync-a)"/>
</svg>
<figcaption>The engine uploads an entry's files first, then sends its ops; each op gets its own answer, and the pull refreshes the read-only copy.</figcaption>
</figure>

On the server, `POST /api/v1/sync/ops` first checks payload versions for the whole batch: below
`MIN_PAYLOAD_VERSION` is 409 `client_outdated`, above `PAYLOAD_VERSION` is 409
`server_outdated`, and nothing is applied. Then each op runs in its own scoped transaction, as the
caller:

- **The ledger** (`sync_ops`): the same key with the same body answers the stored result and
  creates nothing; the same key with another body is dropped as `idempotency_mismatch`.
- **Ids and time:** the client id must fall in the ops window (90 days back, 1 ahead);
  `takenAt` is clamped to the time of receipt (D112).
- **Parents:** an op whose `dependsOn` parent was dropped is dropped as `parent_dropped`.
- **Role:** a viewer's op is `not_permitted`; a location the caller has left is
  `location_revoked`.
- **The handler** in `sync/handlers/`, under a savepoint, writes its own audit events.

Each op is answered `applied`, `needs_review` (it goes to the inbox) or `dropped` with one of
`DROP_REASONS`. An unexpected error stops the batch at that op; the phone sends the rest again
with the same keys, backing off from 5 s to 5 minutes.

## Conflicts

Queue ops skip the `row_version` check that online edits use. Instead,
[D35](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md):
**the latest change wins, visibly**. Ops apply in the order the server receives them and both show
in history. An op on something trashed or missing meanwhile is dropped with a notice ("the drill
was trashed by Alfred") and opens an inbox `sync_drop` item from which it can be restored. No merge
dialogs.

Two exceptions, from D112: meter readings are ordered by when they were taken and checked against
their neighbours (a doubtful one goes to the inbox), and blank-label claims are decided by the
server, first to arrive wins. Short IDs are allocated at sync; until then the phone shows
"ID pending".

## Sign-out and a 401

An explicit sign-out deletes the whole per-user database. A 401 clears the cached inventory at
once but keeps the person's own unanswered ops and their files, locked, until someone signs in
(D210). The same person resumes the queue; anyone else is told how many captures go before they
are discarded.

## Testing it

The queue's rules are pure functions, tested in `apps/web/src/offline/*.test.ts` with
fake-indexeddb. The server side has `sync/ops.test.ts`, `sync/ordering.test.ts`,
`sync/snapshot.test.ts` and two leak tests (`snapshot.leak.test.ts`, `extras.leak.test.ts`) that
prove a phone never receives rows from a location it can't read. See [Testing](/developers/testing/).
