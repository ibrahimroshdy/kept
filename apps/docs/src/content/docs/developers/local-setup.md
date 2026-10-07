---
title: Local setup
description: Get a development copy of Kept running, with its database, mail catcher, seed data and the mock AI provider.
---

You need **Node 24** (`.nvmrc` says `24`), **pnpm 11** and **Docker** with the Compose plugin. The
root `package.json` pins pnpm with `packageManager`, so `corepack enable` gives you the right one.

## 1. Install and hook up

```sh
pnpm install
git config core.hooksPath .githooks
```

The commit-msg hook in `.githooks/` rejects AI attribution in commit messages
(`scripts/check-attribution.sh`). Sign your commits with `git commit -s`; see
[CONTRIBUTING.md](https://github.com/ibrahimroshdy/kept/blob/main/CONTRIBUTING.md).

## 2. Start the database and the mail catcher

```sh
docker compose -f compose.dev.yaml up -d --wait
```

[`compose.dev.yaml`](https://github.com/ibrahimroshdy/kept/blob/main/compose.dev.yaml) (project
name `kept-dev`) starts:

| Service | Image | Host ports |
|---|---|---|
| `db` | `pgvector/pgvector:0.8.6-pg18-bookworm` (Postgres 18 with pgvector) | **5452** → 5432 |
| `mail` | `axllent/mailpit:v1.31.2` | 1025 (SMTP), 8025 (web UI) |
| `s3` (only with `--profile s3`) | RustFS, an S3-compatible store | 9452 → 9000 |

On the database's first start,
[`docker/initdb/01-roles.sql`](https://github.com/ibrahimroshdy/kept/blob/main/docker/initdb/01-roles.sql)
creates the four logins (`kept_owner`, `kept_app`, `kept_auth`, `kept_system`, each with its role
name as its password), makes `kept_owner` own the `kept` database, and creates the `pg_trgm`,
`unaccent` and `vector` extensions in `kept` and in `template1`. These are development passwords
and are never used anywhere else. The superuser is `postgres` / `postgres`; only the tests' setup
uses it.

The ports were chosen not to collide with other Postgres instances on a developer machine. To use
the S3 driver, add `--profile s3` and set `KEPT_STORAGE=s3` and the commented `KEPT_S3_*` lines in
`.env.example` (path-style: `KEPT_S3_FORCE_PATH_STYLE=true`).

## 3. The environment

```sh
cp .env.example .env
set -a; . ./.env; set +a
```

[`.env.example`](https://github.com/ibrahimroshdy/kept/blob/main/.env.example) has the four
database URLs on port 5452, `KEPT_ROLE=all`, `KEPT_LOG_FORMAT=pretty`,
`KEPT_SMTP_URL=smtp://localhost:1025` and `KEPT_STORAGE=local`, plus commented lines for S3, the
AI mock, push, embeddings and OIDC. The server doesn't read `.env` itself; export it in the shell
you start things from. Every variable is in the [configuration reference](/reference/configuration/).

Three things `.env.example` leaves to you:

- **`KEPT_PUBLIC_URL`** is `http://localhost:5173` there. Set it to the address you actually open
  (`http://localhost:8080` when the server serves the web app, step 6). The same-site check
  refuses a cookie-bearing write whose `Origin` isn't the public URL's, and links and QR codes are
  built from it.
- **`KEPT_DATA_DIR` and `KEPT_CONFIG_DIR`** default to `/data` and `/config`, the container's
  volumes. Point them at writable directories on your machine. With `KEPT_SECRET_KEY` and
  `KEPT_AUTH_SECRET` unset, the server generates both into `KEPT_CONFIG_DIR` on first start;
  `pnpm --filter @kept/server kept admin gen-key` prints a key if you'd rather set one.
- **The AI mock.** Uncomment `KEPT_AI_MOCK=1` and every AI call is answered by `ai/mock.ts`
  instead of a provider. It is refused when `NODE_ENV=production`. Never put a real AI key in a
  file Git tracks.

## 4. Migrate

```sh
pnpm --filter @kept/server kept migrate
```

`kept migrate` connects as `kept_owner` (`KEPT_OWNER_DATABASE_URL`), takes an advisory lock,
applies the migrations, installs the pg-boss schema and upserts the reference rows (currencies,
the built-in types). It is safe to run again. More in [migrations](/developers/migrations/).

## 5. Seed some data (optional)

```sh
pnpm --filter @kept/server kept admin seed --scenario households
```

The `households` scenario creates the sample cast and their households: people, places, things
with photos, purchases and history, warranties, loans, documents, and the Garage's car with six
months of readings, fills and services. The accounts' shared password is in the README's
"Development" section. The other scenario, `bench`, is the 10,000-thing load fixture for
[the RLS benchmark](https://github.com/ibrahimroshdy/kept/blob/main/docs/perf/2026-09-26-rls-bench.md).
The seed refuses to run with `NODE_ENV=production`.

## 6. Run it

The server serves the built web app, so build it once, then start the server in watch mode:

```sh
pnpm --filter @kept/web build
pnpm --filter @kept/server dev
```

`dev` runs `tsx watch src/main.ts`. It listens on **8080** (`KEPT_PORT` changes it) and serves
`apps/web/dist` when it holds an `index.html`. With `KEPT_ROLE=all` the same process runs the
jobs. On first start with no admin it prints a setup code (`KEPT SETUP CODE`); with seed data the
admin already exists. Rebuild the web app to see web changes.

For work on screens alone, `pnpm --filter @kept/web dev` starts Vite. In development the web app
has a fixture mode: add `?demo=owner`, `firstrun`, `member`, `setup` or `signedout` to the URL and
the API answers from fixtures (`apps/web/src/demo.ts`).

:::note[No API proxy in Vite]
`apps/web/vite.config.ts` doesn't configure one, so Vite on its own has either the fixtures or no
API. Use the server on 8080 to work against real data.
:::

## Mail

Everything Kept sends in development lands in Mailpit at `http://localhost:8025`: invites, magic
links, password resets, reminders. Without `KEPT_SMTP_URL`, mail is only logged as due.

## Tests

```sh
pnpm test                                     # everything
pnpm test apps/server/test/leak.test.ts       # one file
```

Server tests never touch the `kept` database: the global setup
(`apps/server/test/global-setup.ts`) migrates a template database as `kept_owner`, each Vitest
worker clones its own from it on the development Postgres, and drops it afterwards. Tests pin
`TZ=Africa/Cairo`. `KEPT_TEST_WORKERS=<n>` caps the workers when the machine is busy. More in
[testing](/developers/testing/).

## Testing on a phone

The camera, offline capture, installing to the home screen and push need a secure context:
`localhost` counts, a LAN address over plain HTTP doesn't. The README's "Testing on a phone
(HTTPS)" section shows two ways to put HTTPS in front of port 8080 (a Tailscale certificate, or
mkcert with a TLS proxy). Set `KEPT_PUBLIC_URL` to the HTTPS address the phone opens.

## Tearing down

```sh
docker compose -f compose.dev.yaml down       # keep the data
docker compose -f compose.dev.yaml down -v    # also delete the database volume
```
