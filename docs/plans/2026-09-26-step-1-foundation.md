# Step 1: Foundation. Implementation plan

**Goal:** build Kept's foundation. That means:
- a pnpm monorepo;
- Postgres roles with fail-closed row-level security (RLS) and a schema-wide leak test;
- crypto, audit, modules and API conventions;
- Better Auth sign-in, with accounts, Personal locations, memberships, invites and managed accounts;
- the setup code, the `kept` CLI, jobs and admin alerts;
- a web shell with the design tokens and i18n;
- the image and Compose files, and a local CI gate.

**Architecture:**
- **Fastify API** (`apps/server`) on Postgres 18. The request pool logs in as `kept_app` and
  every request runs inside `withScope()`, which sets `app.user_id` and `app.mfa`. Policies call
  `kept.visible_location_ids()` and deny when no scope is set.
- **Better Auth** runs on its own `kept_auth` login in schema `auth`.
- **pg-boss** jobs run as `kept_system`.
- **React/Vite PWA shell** in `apps/web`. Contracts (errors, modules, ids) live in
  `packages/shared`.

**Tech stack.** Versions come from spike S0 (2026-09-26), looked up on the registries. Pin
exactly.

| Package | Version |
|---|---|
| Node | 24.21.0 LTS (`/opt/homebrew/opt/node@24/bin`) |
| pnpm | 11.23.0 |
| typescript | 7.0.2 |
| fastify | 5.12.5 |
| better-auth | 1.7.6 |
| drizzle-orm | 0.45.3 (1.0 is still RC5, per D100) |
| drizzle-kit | 0.31.11 |
| pg | 8.23.0 |
| pg-boss | 12.34.0 |
| zod | 4.6.5 |
| fastify-type-provider-zod | 7.0.0 |
| @fastify/helmet | 13.1.1 |
| @fastify/swagger | 9.9.0 |
| @fastify/cookie | 11.1.2 |
| pino | 10.3.1 |
| uuid | 14.0.2 |
| commander | 15.0.0 |
| vitest | 5.0.2 |
| @biomejs/biome | 2.5.14 |
| vite | 8.3.1 |
| react | 19.3.0 |
| @tanstack/react-router | 1.170.39 |
| @tanstack/react-query | 5.103.2 |
| @lingui/* | 6.8.0 |
| react-aria-components | 1.21.1 |
| @playwright/test | 1.63.0 |

Postgres image: `pgvector/pgvector:0.8.6-pg18-bookworm` (glibc; tag read from Docker Hub). The
MCP SDK is at 1.30.1; v2 isn't released. That doesn't matter until step 6.

**Ground rules for every task:**
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7.14 beats §7.1–7.13,
  which beat §1.
- **Library APIs:** when an API is unclear, read the installed package's `.d.ts` or README under
  `node_modules`. Never guess. If an API differs from what this plan shows, follow the library and
  note it in the commit body.
- **TDD:** failing test → minimal code → green → commit.
- **Commits** use conventional messages and the repo's local git identity. **Never add
  attribution lines**; the commit-msg hook rejects them.
- **Node 24:** run everything with `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` first.
- **Test time zone:** tests pin `TZ=Africa/Cairo`.
- **Dev ports:** Postgres on 5452, Mailpit on 8025 and 1025. Never touch 5432, 5433 or 5442
  (other apps).
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, and it gates on exit codes only.
- **Commit after every task; do not push.** The repo stays private.

---

## File structure (created across the tasks)

```
.nvmrc  package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  vitest.workspace.ts
compose.dev.yaml  compose.yaml  Dockerfile  .dockerignore  .env.example
docker/initdb/01-roles.sql          dev-only roles and extensions (dev passwords)
scripts/ci-local.sh  scripts/check-attribution.sh  scripts/check-licences.mjs
.githooks/commit-msg
packages/shared/src/
  errors.ts        error-code enum + {error,hint,code} type
  modules.ts       module registry (D184 §7.6)
  roles.ts         role ids + can() matrix
  ids.ts           uuidv7 helpers, ±7-day check
  index.ts
apps/server/
  drizzle.config.ts
  migrations/      drizzle-kit output + custom SQL (generate --custom)
  src/
    config/env.ts            zod env schema + first-boot key generation (D193)
    config/reference.ts      `kept admin config` text
    db/pools.ts              one pg Pool per role
    db/scope.ts              withScope(), withSystem()
    db/schema/*.ts           Drizzle tables
    db/migrate.ts            advisory-locked migrator
    crypto/envelope.ts       AES-256-GCM envelope encryption (§7.3)
    audit/audited.ts         audited(), renderAudit()
    audit/classes.ts         field → plain|money|secret map
    authz/can.ts             re-export of shared can() + location lookup
    http/app.ts              buildApp()
    http/errors.ts           AppError + error handler
    http/health.ts           /healthz /readyz /version
    http/conventions.ts      If-Match, pagination, id window, idempotency
    http/modules.ts          module preHandler
    auth/auth.ts             Better Auth instance
    auth/session.ts          request → {userId, mfa}
    accounts/ensure-account.ts
    locations/*.ts           routes + service
    memberships/*.ts
    invites/*.ts
    managed/*.ts
    admin/*.ts               instance admin routes
    setup/setup-code.ts
    jobs/boss.ts             pg-boss wiring, job registry
    alerts/*.ts              admin alerts
    cli/index.ts             `kept` CLI (commander)
    main.ts                  KEPT_ROLE web|worker|all
  test/
    global-setup.ts          migrate template DB once
    db.ts                    per-worker DB clone + pools
    leak.test.ts             schema-wide leak test
apps/web/                    Vite + React shell (tasks 26–27)
```

---

## Phase A: scaffold and database (tasks 1–5)

### Task 1: Monorepo scaffold

**Files:**
- Create: `.nvmrc`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`,
  `vitest.workspace.ts`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/server/{package.json,tsconfig.json,src/main.ts}`
- Test: `packages/shared/src/index.test.ts`

- [ ] **Step 1: Write the root files.**

  `.nvmrc`:
  ```
  24
  ```

  `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - apps/*
    - packages/*
  ```

  `package.json`:
  ```json
  {
    "name": "kept",
    "private": true,
    "type": "module",
    "packageManager": "pnpm@11.23.0",
    "engines": { "node": ">=24 <25" },
    "scripts": {
      "lint": "biome check .",
      "format": "biome format --write .",
      "typecheck": "pnpm -r --parallel typecheck",
      "test": "TZ=Africa/Cairo vitest run",
      "ci": "bash scripts/ci-local.sh"
    },
    "devDependencies": {
      "@biomejs/biome": "2.5.14",
      "typescript": "7.0.2",
      "vitest": "5.0.2"
    }
  }
  ```

  `tsconfig.base.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2024",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": false,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "declaration": true,
      "sourceMap": true,
      "resolveJsonModule": true
    }
  }
  ```

  `biome.json`: recommended rules, 2-space indent, line width 100, single quotes, and ignores for
  `**/migrations/meta`, `**/dist`, `docs/**`.

  `vitest.workspace.ts`: projects `packages/*` and `apps/server`, each with its own
  `vitest.config.ts`.

- [ ] **Step 2: Create `packages/shared`.**
  - Name `@kept/shared`, `"type": "module"`, with exports `./src/index.ts` (source-first workspace
    package).
  - Scripts: `typecheck: tsc --noEmit`.
  - `src/index.ts` exports `KEPT_VERSION = process.env.KEPT_VERSION ?? '0.0.0-dev'`.
  - Test: `expect(typeof KEPT_VERSION).toBe('string')`.

- [ ] **Step 3: Create `apps/server`.**
  - Name `@kept/server`, depending on `@kept/shared: workspace:*`.
  - Scripts: `typecheck`, `dev: tsx watch src/main.ts`, `build: tsc -p tsconfig.build.json`.
  - `src/main.ts` holds a placeholder `console.log('kept')`; task 7 replaces it.

- [ ] **Step 4: Install and run the checks.**

  ```bash
  export PATH=/opt/homebrew/opt/node@24/bin:$PATH
  pnpm install && pnpm lint && pnpm typecheck && pnpm test
  ```

  Expected: every command exits 0. If TypeScript 7's `tsc` fails on a tool that needs the TS 5 JS
  API, pin `typescript@5` for that package only, and record it in the commit body.

- [ ] **Step 5: Commit.** Message: `chore: scaffold pnpm monorepo`.

### Task 2: Dev Postgres, roles, extensions

**Files:**
- Create: `compose.dev.yaml`, `docker/initdb/01-roles.sql`, `.env.example`
- Test: `apps/server/test/roles.test.ts`

- [ ] **Step 1: Write `compose.dev.yaml`.**

  ```yaml
  name: kept-dev
  services:
    db:
      image: pgvector/pgvector:0.8.6-pg18-bookworm
      environment:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
        POSTGRES_DB: kept
        TZ: UTC
      ports: ["5452:5432"]
      volumes:
        - kept-dev-db:/var/lib/postgresql
        - ./docker/initdb:/docker-entrypoint-initdb.d:ro
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U postgres -d kept"]
        interval: 2s
        retries: 30
    mail:
      image: axllent/mailpit:latest
      ports: ["8025:8025", "1025:1025"]
  volumes:
    kept-dev-db: {}
  ```

  Before committing, look up a pinned Mailpit tag from Docker Hub
  (`curl -s "https://hub.docker.com/v2/repositories/axllent/mailpit/tags?page_size=5"`) and
  replace `latest` with it. Never commit `:latest`.

  PG18 images keep their data under `/var/lib/postgresql`, not `/var/lib/postgresql/data`. Check
  the image's docs if the volume layout errors.

- [ ] **Step 2: Write `docker/initdb/01-roles.sql`.** Dev only; the passwords are dev values.

  ```sql
  CREATE ROLE kept_owner  LOGIN PASSWORD 'kept_owner'  NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE kept_app    LOGIN PASSWORD 'kept_app'    NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE kept_auth   LOGIN PASSWORD 'kept_auth'   NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE kept_system LOGIN PASSWORD 'kept_system' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  -- Tests create a database per worker from a template; only the owner needs CREATEDB, and only in dev.
  ALTER ROLE kept_owner CREATEDB;
  ALTER DATABASE kept OWNER TO kept_owner;
  \connect kept
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS unaccent;
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER SCHEMA public OWNER TO kept_owner;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO kept_app, kept_system;
  -- The migration creates schemas kept, auth and pgboss as kept_owner.
  ```

  Extensions are also created in `template1`, so every cloned test database has them. Repeat the
  three `CREATE EXTENSION` lines after `\connect template1`.

- [ ] **Step 3: Write `.env.example`** from the §7.11 table, with the dev URLs:

  ```
  KEPT_DATABASE_URL=postgres://kept_app:kept_app@localhost:5452/kept
  KEPT_AUTH_DATABASE_URL=postgres://kept_auth:kept_auth@localhost:5452/kept
  KEPT_SYSTEM_DATABASE_URL=postgres://kept_system:kept_system@localhost:5452/kept
  KEPT_OWNER_DATABASE_URL=postgres://kept_owner:kept_owner@localhost:5452/kept
  KEPT_PUBLIC_URL=http://localhost:5173
  KEPT_ROLE=all
  KEPT_LOG_FORMAT=pretty
  KEPT_SMTP_URL=smtp://localhost:1025
  ```

- [ ] **Step 4: Write a failing test,** `apps/server/test/roles.test.ts`.
  - Connect as `postgres` (superuser, test only) to port 5452.
  - Assert the four roles exist, with `rolsuper=false` and `rolbypassrls=false`, and that
    `pg_trgm`, `unaccent` and `vector` exist in `pg_extension`.
  - Run: `docker compose -f compose.dev.yaml up -d --wait && pnpm test`. Expected: PASS.
  - To prove the test bites, recreate the volume without the init script; it should fail.

- [ ] **Step 5: Commit.** Message: `feat(db): dev Postgres with kept roles and extensions`.

### Task 3: Environment schema and first-boot keys (§7.11, D193)

**Files:**
- Create: `apps/server/src/config/env.ts`, `apps/server/src/config/reference.ts`
- Test: `apps/server/src/config/env.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `loadEnv({})` throws. The error lists `KEPT_DATABASE_URL`, `KEPT_AUTH_DATABASE_URL` and
    `KEPT_PUBLIC_URL`.
  - `loadEnv(valid, {configDir})` with no secrets generates both keys (32 random bytes, base64url)
    into `configDir/secrets.json` with mode 0600, and returns them. A second call returns the same
    keys.
  - A supplied `KEPT_SECRET_KEY` shorter than 32 bytes when decoded throws `secret_key_too_short`.
  - Supplied keys are used as given, and nothing is written to `configDir`.
  - `KEPT_ROLE` must be one of `all`, `web` or `worker`. `KEPT_STORAGE` must be `local` or `s3`.
  - With `NODE_ENV=production` and no `KEPT_SOURCE_URL`, `loadEnv` throws `source_url_required`
    (D147). The image sets it from its OCI labels (task 28).

- [ ] **Step 2: Implement `env.ts`.**
  - A zod object per §7.11 (the variables in `.env.example`, plus `KEPT_SECRET_KEY`,
    `KEPT_AUTH_SECRET`, `KEPT_STORAGE`, `KEPT_LOG_LEVEL`, `KEPT_SOURCE_URL`, `KEPT_SETUP_CODE`,
    `KEPT_CONFIG_DIR` defaulting to `/config`, `KEPT_DATA_DIR` defaulting to `/data`, and
    `KEPT_METRICS_TOKEN` optional).
  - `loadEnv(source = process.env, opts?)` returns `Readonly<Env>`.
  - Key generation uses `crypto.randomBytes(32).toString('base64url')`, written atomically
    (write to a temp file, then rename).
  - Log exactly one line saying where the keys are; the caller passes a logger.
  - Keys are decoded with `Buffer.from(v, 'base64url')`, falling back to hex when the value
    matches `/^[0-9a-f]{64}$/i`.

- [ ] **Step 3: Implement `reference.ts`.** It renders a markdown table from the zod schema's
  `.describe()` texts, for `kept admin config` (D81). Test: the output contains every variable name.

- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit.** Message: `feat(config): env contract with first-boot key generation`.

### Task 4: Migrations and `kept migrate` (§7.12)

**Files:**
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/db/migrate.ts`,
  `apps/server/src/cli/index.ts`
- Create: `apps/server/migrations/0000_foundation_schemas.sql`, a custom migration made with
  `drizzle-kit generate --custom --name=foundation_schemas`
- Test: `apps/server/src/db/migrate.test.ts`

- [ ] **Step 1: Write `drizzle.config.ts`.**
  - `dialect: 'postgresql'`, `schema: './src/db/schema/index.ts'`, `out: './migrations'`.
  - `dbCredentials.url = process.env.KEPT_OWNER_DATABASE_URL`.
  - `schemaFilter: ['public','kept']`.
  - `migrations: { table: 'migrations', schema: 'kept_meta' }`.

- [ ] **Step 2: Write the first custom migration,** `0000_foundation_schemas.sql`.

  ```sql
  CREATE SCHEMA IF NOT EXISTS kept;       -- functions
  CREATE SCHEMA IF NOT EXISTS auth;       -- Better Auth tables
  GRANT USAGE ON SCHEMA kept TO kept_app, kept_system, kept_auth;
  GRANT USAGE, CREATE ON SCHEMA auth TO kept_owner;
  GRANT USAGE ON SCHEMA auth TO kept_auth;
  ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kept_app, kept_system;
  ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO kept_app, kept_system;
  ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA auth
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kept_auth;
  ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA kept
    GRANT EXECUTE ON FUNCTIONS TO kept_app, kept_system;
  CREATE SEQUENCE IF NOT EXISTS kept.change_seq;
  GRANT USAGE ON SEQUENCE kept.change_seq TO kept_app, kept_system;

  -- Row bookkeeping for every mutable table (§1, §7.4). Cache columns are excluded by the caller.
  CREATE FUNCTION kept.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.change_seq := nextval('kept.change_seq');
    IF TG_OP = 'UPDATE' THEN
      NEW.row_version := OLD.row_version + 1;
      NEW.updated_at := now();
    END IF;
    RETURN NEW;
  END $$;

  CREATE FUNCTION kept.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
  CREATE FUNCTION kept.current_mfa() RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT coalesce(current_setting('app.mfa', true), '') = 'true' $$;
  ```

- [ ] **Step 3: Write the failing tests,** `migrate.test.ts`.
  - `runMigrations(ownerUrl)` on an empty database creates `kept_meta.migrations` and the
    function `kept.current_user_id`.
  - Two `runMigrations` calls started together with `Promise.all` both resolve, and the migration
    table has exactly one row per migration. This proves the advisory lock.
  - `kept.current_user_id()` returns null when `app.user_id` is unset.

- [ ] **Step 4: Implement `migrate.ts`.**

  ```ts
  import pg from 'pg';
  import { drizzle } from 'drizzle-orm/node-postgres';
  import { migrate } from 'drizzle-orm/node-postgres/migrator';
  import { fileURLToPath } from 'node:url';

  const LOCK_KEY = 0x6b657074; // 'kept'
  export const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

  export async function runMigrations(ownerUrl: string): Promise<void> {
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
      await migrate(drizzle(client), {
        migrationsFolder,
        migrationsTable: 'migrations',
        migrationsSchema: 'kept_meta',
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
      await client.end();
    }
  }
  ```

- [ ] **Step 5: Implement `cli/index.ts`** with commander. The program `kept` has a `migrate`
  command that runs `runMigrations(env.KEPT_OWNER_DATABASE_URL)`, and an `admin` command group
  (filled in later tasks). Add `"bin": {"kept": "src/cli/index.ts"}` and the script
  `"kept": "tsx src/cli/index.ts"`.

- [ ] **Step 6:** Run `pnpm test`. Expected: PASS. Commit: `feat(db): advisory-locked migrator
  and kept migrate`.

### Task 5: Test harness (template DB per worker)

**Files:**
- Create: `apps/server/vitest.config.ts`, `apps/server/test/global-setup.ts`,
  `apps/server/test/db.ts`
- Test: `apps/server/test/harness.test.ts`

- [ ] **Step 1: `global-setup.ts`.**
  - As `postgres`: drop and recreate `kept_test_template`, owned by `kept_owner`.
  - Run `runMigrations` against it as `kept_owner`, then mark it as a template
    (`ALTER DATABASE ... IS_TEMPLATE true`).
  - Pin `process.env.TZ = 'Africa/Cairo'`.

- [ ] **Step 2: `db.ts`.** Export `testDb()`. Per worker (`process.env.VITEST_POOL_ID`), it
  creates `kept_test_<id>` from the template and returns
  `{ urls: {app, auth, system, owner}, pools, reset() }`.
  - `reset()` truncates every table in `public` and `auth` except the reference tables
    (`currencies`), as `kept_owner`. The owner policy (task 9) allows this.

- [ ] **Step 3: Tests.**
  - Two tests in different files both see a clean database.
  - The database name differs per worker.

- [ ] **Step 4: Commit.** Message: `test: template database per vitest worker`.

---

## Phase B: spikes (tasks 6–8). Record each result in `docs/spikes/2026-09-26-<id>.md`

Each spike leaves behind code that the real tasks keep, plus a short result note:
- **what was proven;**
- **the exact config** that worked;
- **the fallback taken, if any.**

If a spike fails, take the fallback written here, **don't stop**, and add a line about it to the
product design §19 row (V14, V16, V32 or V33).

### Task 6: Spike S1 (V33): Better Auth in schema `auth` as `kept_auth` + pg-boss under non-owner roles

- [ ] **Step 1: Generate Better Auth's Drizzle schema.**
  - Use `pnpm dlx @better-auth/cli@1.7.6 generate` (check that the CLI package name exists with
    `npm view`; if it doesn't, read the better-auth docs in `node_modules/better-auth` for the
    generator).
  - Plugins: `twoFactor`, `passkey`, `magicLink`, `username`, `admin`. The admin plugin is only
    for ban and session revocation; Kept's own instance admin is `instance_admins`.
  - Put the tables in `apps/server/src/db/schema/auth.ts` using `pgSchema('auth')`, then run
    `drizzle-kit generate`.
- [ ] **Step 2: Configure Better Auth** in `src/auth/auth.ts`.
  - `database: drizzleAdapter(drizzle(authPool), { provider: 'pg', schema: authTables })`, where
    `authPool` logs in as `kept_auth`.
  - `advanced.database.generateId: () => uuidv7()`. Check the option's name in the `.d.ts`.
  - `secret: env.KEPT_AUTH_SECRET`, `baseURL: env.KEPT_PUBLIC_URL`.
- [ ] **Step 3: Test.** Sign up with email and password through `auth.api.signUpEmail`.
  - The user row exists in `auth.user`, with a UUIDv7 id: version nibble 7, and time within 1 s.
  - Selecting from `public.*` as `kept_auth` fails with a permission error.
- [ ] **Step 4: pg-boss.**
  - `kept migrate` installs pg-boss's schema as `kept_owner`. Use pg-boss's own
    `getConstructionPlans(schema)` or its migration SQL export, found in pg-boss's `.d.ts`, from a
    custom migration or a post-migrate hook in `migrate.ts`.
  - Then grant as follows:
    - `kept_app`: INSERT on `pgboss.job` plus whatever `send()` touches (find out by running it).
    - `kept_system`: full DML on schema `pgboss`.
  - Start pg-boss as `kept_system` with `migrate: false` and `schema: 'pgboss'`, or the 12.x
    equivalent option names.
- [ ] **Step 5: Test.**
  - Inside a `kept_app` transaction, `boss.send('noop', {})`, using pg-boss's `db` option to run
    on the transaction's client, then commit.
  - The worker on `kept_system` receives the job.
  - After a rollback, no job arrives.
- [ ] **Fallbacks:**
  - If Better Auth can't use a separate schema, put its tables in `public` under
    `auth_`-prefixed names. `kept_auth` gets DML on only those tables, and the leak test
    allowlists them.
  - If pg-boss can't enqueue inside our transaction, write an outbox table in the transaction, and
    have a `kept_system` relay send the jobs. This mirrors L-series lessons on at-least-once
    delivery.
- [ ] **Step 6: Write the result note** `docs/spikes/2026-09-26-s1.md`. Commit:
  `spike(S1): better-auth and pg-boss under non-owner roles`.

### Task 7: Spike S2 (V32): two-factor on every sign-in method + a shared DB rate limiter

- [ ] **Step 1: TOTP on password sign-in.** Enable TOTP for a user. Password sign-in must return
  "two-factor required" and create no full session. Check this with a test.
- [ ] **Step 2: Magic link and passkey.**
  - Magic link: sign in with it for the same user. Is a session created without two-factor?
  - Passkey: if not practical in Node, check whether the WebAuthn verification path runs the
    two-factor hook, by reading the source in `node_modules/better-auth/dist/plugins/passkey`.
    Document what you find.
- [ ] **Step 3: The gate.** Unless Better Auth gates every method, implement Kept's own gate:
  - **Session flag:** a `session_mfa` table (`session_id` PK, `satisfied_at`). `auth/session.ts`
    resolves `mfa = satisfied || user has no 2FA || the session came from a passkey with UV`.
  - **Blocking unenrolled sessions:** requests from a session with 2FA enrolled but
    `mfa = false` are refused on every route except `/api/v1/auth/2fa/*` and sign-out, with
    `403 {code:'mfa_required'}`. Tests cover each method.
- [ ] **Step 4: Rate limiter.**
  - Configure `rateLimit: { storage: 'database', ... }`, or whatever the option is named in 1.7.6.
  - Test with two Better Auth instances on the same database: 6 bad sign-ins split across both
    instances hit the limit.
  - Keys are account + IP (D176). If only IP is supported, add Kept's own account key: a table
    `sign_in_failures(account_key, window_start, count)` checked in a before-hook, with the
    progressive delays from product design D176.
- [ ] **Step 5: Write the result note.** Commit: `spike(S2): two-factor on every method and a
  shared rate limiter`.

### Task 8: Spike S3 (V14): managed accounts

- [ ] Use the `username` plugin to create a user with the email `<uuid>@managed.invalid` and a
  username.
- [ ] Sign in by username and password. Magic link must be impossible: the send function refuses
  `.invalid` addresses.
- [ ] Admin-issued one-time reset code (D164): an 8-character code, stored hashed, expiring after
  30 minutes. Redeeming it sets the password and revokes all the user's sessions. The Better Auth
  pieces to use are `auth.api.setPassword` or the internal adapter; find them in the `.d.ts`.
- [ ] Write the result note. Commit: `spike(S3): managed accounts`.

---

## Phase C: the tenancy core (tasks 9–16)

### Task 9: Tenancy schema, reference data, and a minimal places table

**Files:**
- Create in `apps/server/src/db/schema/`: `common.ts`, `tenancy.ts`, `places.ts`,
  `currencies.ts`, `audit.ts`, `index.ts`
- Migrations: generated by drizzle-kit, plus the custom `NNNN_tenancy_triggers.sql`
- Test: `apps/server/src/db/schema.test.ts`

- [ ] **Step 1: `common.ts` defines the column helpers.**

  ```ts
  import { sql } from 'drizzle-orm';
  import { bigint, integer, timestamp, uuid } from 'drizzle-orm/pg-core';
  export const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
  export const mutable = {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rowVersion: integer('row_version').notNull().default(1),
    changeSeq: bigint('change_seq', { mode: 'bigint' }),
  };
  ```

  **Enums are text + CHECK** (D183). Write a helper
  `textEnum(name, values) → { col, check(tableName) }`, which emits
  `check('<table>_<col>_chk', sql\`${col} IN (...)\`)`.

- [ ] **Step 2: Tables, following engineering spec §1.2 with the §7.13 amendments.**
  - **`currencies`:**
    - Columns: `code` char(3) PK, `name`, `minor_units` int, `symbol`, `enabled` bool.
    - Seed USD, CAD, GBP, EUR and EGP, enabled, with `minor_units` 2 each.
    - The seed is a custom migration.
  - **`user_profiles`:**
    - Columns as in §1.2, plus `user_id` uuid PK referencing `auth.user(id)` ON DELETE CASCADE.
    - `digits`, `units` and `theme` are text enums.
  - **`owner_accounts`:** `id`, `user_id` UNIQUE, `created_at`. `billable` is derived; it gets no
    column.
  - **`locations`:**
    - Every §1.2 column.
    - `kind` is an enum.
    - `currency` is a foreign key to `currencies`.
    - `preset`: `essentials` · `household` · `complete`.
    - Partial unique index: one `personal` location per `owner_account_id`.
    - `UNIQUE (id, owner_account_id)`.
  - **`location_modules`:** `location_id`, `module`, `enabled`, `enabled_at`.
  - **`user_hidden_modules`:** as in §1.2.
  - **`memberships`:**
    - Columns: `id`, `location_id`, `user_id`, `role` (enum), `expires_at`, `invited_by`.
    - `UNIQUE (location_id, user_id)`.
    - Partial unique index: one owner per location (`WHERE role = 'owner'`).
  - **`invites`:** as in §1.2. `token_hash` is UNIQUE.
  - **`instance_settings`:** `key` PK, `value` jsonb.
  - **`instance_admins`:** `user_id` PK, `granted_by`, `granted_at`.
  - **`idempotency_keys`:** PK (`user_id`, `key`), `request_hash`, `response` jsonb, `created_at`.
  - **`places` (minimal):**
    - Columns: `id`, `location_id`, `parent_id` null, `name`, `kind_key` text default
      `'room'`, `is_unplaced` bool default false, `deleted_at`, plus the mutable columns.
    - `UNIQUE (location_id, id)`.
    - Composite FK (`location_id`, `parent_id`) → `places(location_id, id)` ON UPDATE CASCADE ON
      DELETE RESTRICT.
    - Partial unique index: one Unplaced area per location.
  - **`sync_tombstones`:** as in §7.4, with PK (`location_id`, `entity_type`, `entity_id`).
  - **`audit_events`:** partitioned by RANGE on `at`, with PK (`id`, `at`). Columns: `location_id`
    null, `owner_account_id` null, `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`,
    `root_thing_id` null, `diff` jsonb, `at`. Write this table as custom SQL; Drizzle can't emit
    partitioning. Declare it in Drizzle for querying only.
  - **`audit_event_subjects`:** `event_id`, `event_at`, `thing_id`.

- [ ] **Step 3: Custom migration `tenancy_triggers.sql`.**
  - `touch_row` triggers (BEFORE INSERT OR UPDATE) on every table that has `row_version`.
  - A DEFAULT partition for `audit_events`, plus partitions for the current month and the next.
  - A deferred constraint trigger, `kept.check_location_owner()`, which verifies after each
    statement that every location has exactly one `owner` membership whose `user_id` matches
    `owner_accounts.user_id` for `locations.owner_account_id`.
  - A place-loop trigger, and a trigger that forbids trashing or re-parenting an Unplaced area.

- [ ] **Step 4: Tests, run as `kept_owner`.**
  - The five currencies are present.
  - Inserting a location with currency `XYZ` fails on the foreign key.
  - Two personal locations for one account fail.
  - An update bumps `row_version` and sets `change_seq`.
  - Committing a location with no owner membership fails; the deferred trigger fires at commit.
  - A place loop fails.

- [ ] **Step 5: Commit.** Message: `feat(db): tenancy schema, currencies and minimal places`.

### Task 10: RLS (§7.2, D178, D190)

**Files:**
- Custom migration `NNNN_rls.sql`
- Test: `apps/server/src/db/rls.test.ts`

- [ ] **Step 1: Write the functions.** All are owned by `kept_owner`, `SECURITY DEFINER`, with a
  fixed `search_path`.

  ```sql
  CREATE FUNCTION kept.visible_location_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT m.location_id FROM public.memberships m
    JOIN public.locations l ON l.id = m.location_id
    WHERE m.user_id = kept.current_user_id()
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND l.deleted_at IS NULL
      AND (NOT l.require_2fa OR kept.current_mfa())
  $$;

  CREATE FUNCTION kept.writable_location_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT m.location_id FROM public.memberships m
    JOIN public.locations l ON l.id = m.location_id
    WHERE m.user_id = kept.current_user_id()
      AND m.role IN ('owner','admin','member')
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND l.deleted_at IS NULL
      AND (NOT l.require_2fa OR kept.current_mfa())
  $$;

  CREATE FUNCTION kept.admin_location_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT location_id FROM kept.writable_location_ids() w
    JOIN public.memberships m ON m.location_id = w AND m.user_id = kept.current_user_id()
    WHERE m.role IN ('owner','admin')
  $$;

  CREATE FUNCTION kept.current_owner_account_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT id FROM public.owner_accounts WHERE user_id = kept.current_user_id()
  $$;

  CREATE FUNCTION kept.is_instance_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (SELECT 1 FROM public.instance_admins WHERE user_id = kept.current_user_id())
  $$;
  ```

  In `admin_location_ids()`, fix the join: `w` is a set of uuids. Write it as
  `SELECT w FROM kept.writable_location_ids() AS w JOIN ... ON m.location_id = w`. Test that the
  function compiles.

- [ ] **Step 2: Policies.** Every table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and
  `CREATE POLICY owner_all ON <t> FOR ALL TO kept_owner USING (true) WITH CHECK (true);`.

  | Table | `kept_app` policies |
  |---|---|
  | `currencies` | SELECT `true` |
  | `locations` | SELECT `id IN (SELECT kept.visible_location_ids())`<br>INSERT CHECK `owner_account_id = kept.current_owner_account_id()`<br>UPDATE USING/CHECK `id IN (SELECT kept.admin_location_ids())`<br>no DELETE (deletion is a soft `deleted_at`, set by an owner-only route through `can()`) |
  | `places`, `location_modules`, `sync_tombstones` | SELECT visible<br>INSERT/UPDATE/DELETE writable |
  | `memberships` | SELECT visible<br>INSERT/UPDATE/DELETE: admin locations, **or** (INSERT only) `role='owner' AND user_id = kept.current_user_id() AND location_id IN (SELECT id FROM locations WHERE owner_account_id = kept.current_owner_account_id())`. That subselect runs under the locations SELECT policy, which fails for a brand-new location, so wrap it in a definer function `kept.owns_location(uuid)`. |
  | `invites` | ALL on admin locations |
  | `user_profiles` | ALL where `user_id = kept.current_user_id()`<br>plus SELECT for fellow members: `user_id IN (SELECT user_id FROM memberships WHERE location_id IN visible)`, which needs a definer function `kept.fellow_member_ids()` |
  | `owner_accounts` | SELECT/INSERT where `user_id = kept.current_user_id()` |
  | `user_hidden_modules` | ALL own |
  | `idempotency_keys` | ALL own |
  | `instance_settings`, `instance_admins` | ALL where `kept.is_instance_admin()`. `instance_admins` also gets SELECT own row. |
  | `audit_events` | SELECT where `location_id IN visible`, or (`location_id IS NULL AND owner_account_id = kept.current_owner_account_id()`)<br>INSERT where `location_id IS NULL OR location_id IN visible` (viewers do generate audit events, e.g. reveals) |
  | `audit_event_subjects` | follows its event, through a definer function |

  `kept_system` policies: explicit `FOR ALL TO kept_system USING (true)` only on the tables the
  system jobs need in step 1 (`memberships`, for expiry; `owner_accounts` and `user_profiles`,
  for the orphan repair; `instance_settings`, for the setup code; `audit_events`). Any other table
  is denied to it.

- [ ] **Step 3: Tests.** Run as `kept_app` through `withScope`; write a local helper until task 11
  exists.
  - With no scope, `SELECT * FROM locations` returns 0 rows. It returns no error, only nothing.
  - User A sees only A's locations.
  - A viewer's UPDATE on `places` affects 0 rows.
  - A member of a `require_2fa` location with `mfa=false` doesn't see it; with `mfa=true` they do.
  - An expired membership sees nothing.
  - A location in its deletion grace is invisible.
  - An instance admin can read `instance_settings`; a non-admin gets 0 rows.

- [ ] **Step 4: Commit.** Message: `feat(db): fail-closed RLS with definer membership functions`.

### Task 11: Pools and `withScope()`

**Files:**
- Create: `apps/server/src/db/pools.ts`, `apps/server/src/db/scope.ts`
- Test: `apps/server/src/db/scope.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `withScope(pools.app, {userId, mfa}, fn)` runs `fn` in a transaction where
    `current_setting('app.user_id', true)` equals the user id.
  - After it returns, a new query on the same pool sees an empty `app.user_id`. This proves the
    setting is transaction-local, and it needs `max: 1` in the test pool.
  - When `fn` throws, the work is rolled back.
  - `withSystem(pools.system, fn)` runs with no user scope.

- [ ] **Step 2: Implement.**

  ```ts
  // pools.ts
  import pg from 'pg';
  export type Pools = { app: pg.Pool; auth: pg.Pool; system: pg.Pool };
  export function createPools(env: { KEPT_DATABASE_URL: string; KEPT_AUTH_DATABASE_URL: string; KEPT_SYSTEM_DATABASE_URL: string }): Pools {
    const mk = (url: string, name: string) => new pg.Pool({ connectionString: url, application_name: `kept-${name}`, max: 10 });
    return { app: mk(env.KEPT_DATABASE_URL, 'app'), auth: mk(env.KEPT_AUTH_DATABASE_URL, 'auth'), system: mk(env.KEPT_SYSTEM_DATABASE_URL, 'system') };
  }

  // scope.ts
  import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
  import type pg from 'pg';
  import * as schema from './schema/index.js';
  export type Tx = NodePgDatabase<typeof schema>;
  export type Scope = { userId: string; mfa: boolean };

  async function inTx<T>(pool: pg.Pool, setup: (c: pg.PoolClient) => Promise<void>, fn: (tx: Tx, client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setup(client);
      const result = await fn(drizzle(client, { schema }), client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  export const withScope = <T>(pool: pg.Pool, scope: Scope, fn: (tx: Tx, client: pg.PoolClient) => Promise<T>) =>
    inTx(pool, (c) => c.query("SELECT set_config('app.user_id', $1, true), set_config('app.mfa', $2, true)", [scope.userId, String(scope.mfa)]).then(() => {}), fn);

  export const withSystem = <T>(pool: pg.Pool, fn: (tx: Tx, client: pg.PoolClient) => Promise<T>) =>
    inTx(pool, async () => {}, fn);
  ```

  The raw `client` is passed along so pg-boss `send()` can run on the same transaction (task 6).

- [ ] **Step 3:** Go back and use `withScope` in the RLS tests. Commit: `feat(db): role pools and
  transaction-scoped withScope`.

### Task 12: The schema-wide leak test (D178, L30)

**Files:**
- Test: `apps/server/test/leak.test.ts`

- [ ] **Step 1: Catalogue assertions**, from `pg_class` and `pg_policy`. For every table in
  `public`:
  - `relrowsecurity` and `relforcerowsecurity` are true;
  - there is at least one policy for `kept_app`;
  - there is an `owner_all` policy;
  - there is no policy `TO public`.
  - For `auth.*`: `kept_app` and `kept_system` have no privileges (`has_table_privilege`).
  - Views have `security_invoker=true`.

- [ ] **Step 2: Two-tenant fixture.**
  - As owner, create users A and B, their accounts, a location each, owner memberships, a place
    each, and an audit event each.
  - Then, for every table with a `location_id` or `owner_account_id` column, found from
    `information_schema`:
    - under A's scope, `SELECT count(*) WHERE <col> = B's id` is 0;
    - an UPDATE and a DELETE targeting B's rows affect 0 rows;
    - an INSERT with B's `location_id` raises a policy violation.
  - The test is generated from the catalogue, so new tables are covered automatically.

- [ ] **Step 3: Worker path.** Under `kept_system`, tables not on the system allowlist return a
  permission-denied error or 0 rows.

- [ ] **Step 4: ID collision.** Inserting a place with B's place id under A's scope gives the
  same error code (`23505` mapped to `not_found` at the API) as a random id that exists nowhere.
  Assert on the mapped error from task 16's helper; until then, keep it a `.todo` and complete it
  in task 16.

- [ ] **Step 5: Commit.** Message: `test: schema-wide cross-tenant leak test`.

### Task 13: `can()` and the shared contracts

**Files:**
- Create: `packages/shared/src/{roles.ts,errors.ts,ids.ts}`
- Test: `packages/shared/src/roles.test.ts`, `ids.test.ts`

- [ ] **`errors.ts`.**
  - `export const ErrorCode = { ... } as const`, with the step-1 codes: `validation`,
    `unauthenticated`, `mfa_required`, `forbidden`, `not_found`, `conflict`,
    `precondition_failed`, `module_off`, `rate_limited`, `id_out_of_window`, `idempotency_mismatch`,
    `setup_required`, `setup_code_invalid`, `invite_invalid`, `last_owner`, `internal`.
  - `type ApiError = { error: string; hint?: string; code: ErrorCode }`.
- [ ] **`roles.ts`.**
  - `type Role = 'owner'|'admin'|'member'|'viewer'`.
  - `type Action = ...`: a string union of every row in product design §7.1 that exists in
    step 1, plus rows added later. Read §7.1 and transcribe it; don't invent rows.
  - `const MATRIX: Record<Action, readonly Role[]>`.
  - `can(role, action): boolean`.
  - Test: a table-driven test with one case per matrix cell, from a fixture copied out of §7.1.
- [ ] **`ids.ts`.**
  - `newId()` wraps `v7()` from `uuid`.
  - `isV7(id)`.
  - `withinWindow(id, now = Date.now(), days = 7)` extracts the 48-bit ms timestamp.
  - Tests: an id 8 days old is false; an id 6 days old is true; a v4 id is false.
- [ ] **Commit:** `feat(shared): error codes, role matrix, id helpers`.

### Task 14: The crypto module (§7.3)

**Files:**
- Create: `apps/server/src/crypto/envelope.ts`
- Test: `envelope.test.ts`

- [ ] **Step 1: Tests.**
  - `seal({key, keyVersion:1}, plaintext, aad)` → `open(keyring, sealed, aad)` round-trips.
  - Opening with a different AAD (another row id) throws `crypto_aad_mismatch`. The GCM tag fails;
    map it.
  - Tampering one byte of the ciphertext throws.
  - `rewrap(sealed, oldKeyring, newKey)` keeps the plaintext and changes `keyVersion`.
  - The sealed format is a stable JSON-safe object:
    `{v:1, kv, dek: base64, iv: base64, ct: base64, tag: base64}`.

- [ ] **Step 2: Implement.**
  - A per-row 32-byte data key (DEK) encrypts the value: AES-256-GCM with a 12-byte IV and the
    AAD = `table|row_id|field_key`.
  - The DEK itself is wrapped by the master key with AES-256-GCM (its own IV, and the AAD
    `dek|table|row_id|field_key`). Store `dek` as `iv‖ct‖tag`.
  - `Keyring = Map<number, Buffer>`.

- [ ] **Step 3: Add `kept admin gen-key`** to the CLI; it prints 32 random bytes as base64url.
  Commit: `feat(crypto): envelope encryption with row-bound AAD`.

  `rotate-key` needs the tables that hold ciphertexts. It lands with the first such table (AI keys
  and channels, in step 3 or 4). Record this as a TODO in `docs/plans/step-1-carryover.md`.

### Task 15: `audited()` and `renderAudit()` (§7.5)

**Files:**
- Create: `apps/server/src/audit/{audited.ts,classes.ts,render.ts}`
- Test: `audited.test.ts`

- [ ] **Tests.**
  - `audited(tx, {locationId, actor, action:'location.update', entity:{type:'location', id}, before, after})`
    writes one `audit_events` row whose `diff` contains only the changed fields.
  - A field classed `secret` stores `{changed:true}`, and neither the before nor the after value
    appears anywhere in the row's JSON text.
  - A field classed `money` is stored in full, but `renderAudit(event, viewer)` hides it from a
    viewer when `money_visible_to_viewers` is false (D110).
  - `subjects: [thingIds]` writes `audit_event_subjects` rows.
- [ ] **Implement:**
  - `classes.ts`: a static map `{ 'locations.name': 'plain', ... }`, with default `plain`.
  - `audited` takes the `Tx`. It computes the diff with a deep-equality check per top-level
    field.
- [ ] **Commit:** `feat(audit): audited helper with secret and money classes`.

### Task 16: HTTP skeleton, conventions and module gating (§7.6, §7.7, D81, D181)

**Files:**
- Create: `apps/server/src/http/{app.ts,errors.ts,health.ts,conventions.ts,modules.ts}`
- Create: `packages/shared/src/modules.ts`
- Create: `apps/server/src/main.ts`
- Test: `http/*.test.ts`, using `app.inject()`

- [ ] **`buildApp({env, pools, logger})`:**
  - Fastify with the zod type provider (`fastify-type-provider-zod`: `validatorCompiler`,
    `serializerCompiler`).
  - A pino logger that redacts `req.headers.authorization`, `req.headers.cookie` and any `token=`
    in URLs.
  - A `genReqId` that uses uuidv7, echoed as the `x-request-id` header.
  - `@fastify/helmet` with the CSP `default-src 'self'; frame-ancestors 'none'`. HSTS only when
    `KEPT_PUBLIC_URL` is https.
  - `@fastify/swagger`, serving the OpenAPI document at `/api/v1/openapi.json`.
- [ ] **`errors.ts`:**
  - `class AppError(code, status, hint?)`.
  - Map Postgres errors:
    - `42501`, or an RLS violation on a write, → 404 `not_found`;
    - `23505` on a primary key → 404 `not_found` for client-supplied ids (§7.7, D178); on any
      other unique index → 409 `conflict`;
    - `23503` → 409 `conflict`.
  - zod validation → 400 `validation`.
  - Every error is `{error, hint?, code}`. A 500 never includes a stack trace.
- [ ] **`health.ts`:**
  - `/healthz` returns 200 `{ok:true}`.
  - `/readyz` runs `SELECT 1` on the app and system pools; 503 when one fails.
  - `/version` returns `{version, revision, source}` (D147).
  - `/metrics` is served only when `KEPT_METRICS_TOKEN` is set, and requires it as a bearer token.
- [ ] **`conventions.ts`:**
  - `requireIfMatch(req)` parses `If-Match`, and `checkVersion(row, expected)` throws a 412 with
    `{conflicts: [...fields]}`.
  - `paginate(query)` gives cursor pagination: default 20 per page, max 200. The opaque cursor is
    base64url JSON `{k: lastKey}`.
  - `assertClientId(id)` → `id_out_of_window`.
  - `withIdempotency(tx, userId, key, requestHash, fn)` stores the response and returns it on a
    repeat. A repeat with a different hash → 409 `idempotency_mismatch`.
- [ ] **`packages/shared/src/modules.ts`:**
  - `type ModuleId`, and
    `const MODULES: Record<ModuleId, {deps: ModuleId[]; label: string; presets: Preset[]}>`, from
    product design §5 as re-cut by D191: Vehicles is in Household; the AI modules' effective state
    needs a resolved provider.
  - `effectiveModules(enabledSet, {providerResolved})` returns the modules that are on.
  - `presetModules(preset)`.
  - Tests:
    - disabling a dependency turns off its dependents;
    - the AI modules are off without a provider;
    - Household includes `vehicles`.
- [ ] **`http/modules.ts`:**
  - A preHandler reading `routeOptions.config.module`, which resolves the location from
    `params.locationId` or `body.location_id`.
  - It returns 404 `module_off` for GET and 409 `module_off` for writes.
  - Test with a fake route.
- [ ] **`main.ts`:**
  - `loadEnv` → `runMigrations` is **not** called here (the one-shot job does it) → `createPools`
    → `buildApp` → `listen(8080)` when `KEPT_ROLE` is `web` or `all`.
  - Start the pg-boss worker when `KEPT_ROLE` is `worker` or `all`.
  - Graceful SIGTERM.
- [ ] **Complete task 12's step 4** (the id-collision assertion).
- [ ] **Commit:** `feat(http): fastify skeleton, error shape, conventions, module gating`.

---

## Phase D: accounts and people (tasks 17–23)

### Task 17: Better Auth mounted, with sessions (D176, §7.10)

- [ ] Mount `auth.handler` at `/api/v1/auth/*`, using Better Auth's Fastify integration; read its
  docs for the Fastify pattern (converting to a Web `Request`).
- [ ] Methods: email and password, TOTP with backup codes, passkeys, magic link.
- [ ] **Magic link:**
  - The link opens `/auth/confirm#token=...`, with the token in the fragment.
  - That page POSTs the token. A GET never consumes it (D176).
- [ ] **Sessions:**
  - 30 days, sliding; the token is rotated at sign-in.
  - A password or 2FA change signs out every other session.
  - Cookies are `Secure` when the public URL is https. Over plain HTTP, sessions last 12 h (D181).
- [ ] **`auth/session.ts`:**
  - `resolveScope(req): Promise<Scope | null>` → `{userId, mfa}`, using the S2 gate.
  - A preHandler decorates `req.scope`. Protected routes return 401 `unauthenticated`, or 403
    `mfa_required` per the S2 gate.
- [ ] **Email change (D176):** confirmed at the *old* address first, then verified at the new one.
  - If Better Auth's `changeEmail` doesn't do old-address confirmation, gate it with our own
    `email_change_requests` table.
- [ ] **Device list:**
  - `GET /api/v1/me/sessions` lists sessions: user agent, created time, last active time.
  - `DELETE /api/v1/me/sessions/:id` revokes one.
- [ ] **Tests:** an auth-flow security suite (`auth.security.test.ts`):
  - the magic-link GET doesn't sign in;
  - the rate limit applies;
  - a password change revokes other sessions;
  - a cookie is not `Secure` over http;
  - an unknown email and a wrong password give the same response shape and timing class (no
    account enumeration).
- [ ] **Commit:** `feat(auth): better-auth sign-in, sessions and security suite`.

### Task 18: `ensureAccount()` (D114, D190)

- [ ] Signature: `ensureAccount(pools, userId, opts?: {inviteToken?})`. In one `withScope` (mfa
  true, since the account is new) it:
  1. inserts `owner_accounts` if missing, with `ON CONFLICT (user_id) DO NOTHING`;
  2. inserts `user_profiles` if missing, with defaults: timezone and locale from the request's
     headers, and fallbacks `UTC` and `en`;
  3. inserts the `personal` location if missing: named "Personal", kind `personal`, preset
     `household` (D191), timezone from the profile, currency `USD` unless the locale says
     otherwise (`ar-EG` → EGP, `en-GB` → GBP, `en-CA`/`fr-CA` → CAD, a eurozone locale → EUR);
  4. inserts the owner membership;
  5. inserts the Unplaced place;
  6. consumes the invite, if a token is given (task 20).
- [ ] It is idempotent: a second call makes no new rows. A test calls it twice at the same time
  and gets exactly one of each.
- [ ] **Wiring:**
  - Better Auth `databaseHooks.user.create.after` calls it.
  - The session preHandler calls it through a cheap check, cached per process (an LRU of user ids
    already ensured).
- [ ] **System job `repair-orphans`** (every hour): `kept_system` finds `auth.user` rows with no
  `owner_accounts` row and runs `ensureAccount` for each.
  - This needs `kept_system` to have SELECT on `auth.user`: add a grant for that one table only.
  - Test it.
- [ ] **Commit:** `feat(accounts): two-step account creation with Personal location`.

### Task 19: Locations and memberships (D46, D48, D180, D190)

- [ ] **Routes** (all through `withScope` and `can()`):
  - `POST /api/v1/locations`: creates a location with its owner membership, Unplaced area,
    `location_modules` from the preset, and template rooms given as `rooms: string[]`. Audited.
  - `GET /api/v1/locations`: lists the locations the user can see.
  - `GET /api/v1/locations/:id`: 404 when not visible.
  - `PATCH /api/v1/locations/:id`: `If-Match` required; admin and above.
  - `DELETE /api/v1/locations/:id`: owner only. Soft-deletes it: `deleted_at = now()`,
    `purge_after = now() + 30 days` (D149). Personal can't be deleted.
  - `GET /api/v1/locations/:id/members`.
  - `PATCH /api/v1/locations/:id/members/:membershipId`: changes the role or expiry.
    - Admins manage members and viewers; only the owner manages admins (D48).
    - A membership's expiry can't be later than the inviting admin's own expiry (D46, D180).
    - Nobody can change the owner row.
  - `DELETE /api/v1/locations/:id/members/:membershipId`: removes a member, or the user leaves.
    The owner can't leave; that's `last_owner`.
  - `POST /api/v1/locations/:id/modules`: toggles a module, admin and above.
- [ ] **Owner notification:** when a membership is created, a `notify-owner-new-member` job is
  queued inside the transaction (D180). Delivery is an email if SMTP is configured; otherwise it
  is recorded for the notification centre, which comes in step 4. For now, log it plus write an
  audit event.
- [ ] **System job `expire-memberships`** (every 15 min): deletes expired memberships and writes an
  audit event for each.
- [ ] **Tests:** each role rule; the expiry cap; the audit rows; the 404 for an outsider.
- [ ] **Commit:** `feat(locations): locations, memberships, module toggles`.

### Task 20: Invites (D33, §7.10)

- [ ] `POST /api/v1/locations/:id/invites` (admin and above) takes `{role, membershipExpiresAt?, email?}`.
  - It returns `{url, qrSvg}`. The QR code (D193) is rendered server-side with a QR library; pick
    an MIT one after checking it on npm.
  - The token is 32 random bytes; only its sha256 is stored. The invite expires in 7 days.
  - An email invite is also mailed when SMTP is set.
- [ ] `GET /api/v1/invites/:token`: a public preview (location name, role, inviter), or 404.
- [ ] `POST /api/v1/invites/:token/accept`: for a signed-in user.
  - `ensureAccount(..., {inviteToken})` consumes the invite and creates the membership in one
    transaction.
  - A link invite is single-use.
  - An email invite requires the user's verified email to equal `invites.email`.
- [ ] Invite-token lookup needs a definer function, `kept.invite_by_token_hash(hash)`, because the
  accepter isn't a member yet.
- [ ] **Tests:** accepting twice fails the second time; an email mismatch fails; an expired invite
  fails; accepting creates the membership with the right role and expiry.
- [ ] **Commit:** `feat(invites): single-use link and email invites with QR`.

### Task 21: Managed accounts (D47, D127, D164)

- [ ] **Create:** `POST /api/v1/locations/:id/managed-accounts` (admin and above) takes
  `{displayName, username, role}`.
  - It creates a Better Auth user through the S3 path: a synthetic `.invalid` email, and
    `user_profiles.managed = true` with `created_by_user_id`.
  - Then it adds a membership.
  - A managed account can't own a non-personal location. Enforce this in the create-location
    route (403 `forbidden`).
- [ ] **Reset:** `POST /api/v1/managed-accounts/:userId/reset-code`, allowed for the creator or the
  owner of a location the account belongs to. It returns an 8-character one-time code (S3), revokes
  the account's sessions, and is audited.
- [ ] **Tests:** username sign-in works; the reset code works exactly once; the permission rules
  hold.
- [ ] **Commit:** `feat(managed): managed accounts with admin reset codes`.

### Task 22: Setup code and first run (D32, D190, D193)

- [ ] **`setup/setup-code.ts`:** at boot in the web role, as `kept_system`:
  1. take `pg_advisory_xact_lock(0x73657475)`;
  2. if there are no instance admins and no `setup_code_hash` in `instance_settings`, generate a
     6-character Crockford code (or use `KEPT_SETUP_CODE`);
  3. store its hash;
  4. print exactly `KEPT SETUP CODE: XXX-XXX` to stdout. It is printed only by the process that
     inserted it.
- [ ] **`GET /api/v1/setup`** returns `{needed: boolean}`.
- [ ] **`POST /api/v1/setup`** takes `{code, email, password, displayName}`.
  - It checks the code (constant-time), creates the Better Auth user, and runs `ensureAccount`.
  - It inserts `instance_admins` using the system pool, deletes `setup_code_hash`, and writes an
    audit event.
  - A wrong code is rate-limited: 10 tries, then a 15-minute lockout.
- [ ] **Recovery-kit acknowledgement (D193):** not required at setup. Store `instance_settings`
  `recovery_kit_acknowledged_at`. The gate helper `requireRecoveryKitAck()` is used by later steps
  (secrets, AI keys, backups); write the helper and its test now.
- [ ] **Tests:**
  - two concurrent boots print exactly one code;
  - setup works once, and a second attempt gets 409 `conflict`;
  - a wrong code is refused;
  - after setup the first user is an instance admin.
- [ ] **Commit:** `feat(setup): one-time setup code and first instance admin`.

### Task 23: Instance admin routes and the `kept admin` CLI (D164, D165, D180)

- [ ] **Routes,** gated by `kept.is_instance_admin()` through `can`-style middleware:
  - `GET /api/v1/admin/users`: users with role summaries.
  - `POST /api/v1/admin/users/:id/disable` and `/enable`.
  - `POST .../reset-2fa`.
  - `POST .../sign-out-everywhere`.
  - `GET/PUT /api/v1/admin/settings`, which covers `signup_open`. The environment wins, and
    env-set values come back as `{value, locked: true}`.
  - `POST /api/v1/admin/instance-admins` and `DELETE /api/v1/admin/instance-admins/:userId`.
    Removing the last instance admin fails.
- [ ] **Transparency (D180):** every instance-admin action on another user's account queues an
  email to that user, and is audited.
- [ ] **CLI** (`kept admin`, run as `kept_owner`):
  - `reset-password <email|username>` prints a one-time code;
  - `setup-code` re-issues the setup code;
  - `disable-user`;
  - `transfer-ownership <locationId> <toUserId>`;
  - `recovery-kit`, which prints the key material for now (D165; the full kit comes in step 8).
  - Each is an integration test.
- [ ] **Sign-up toggle:** Better Auth's sign-up route is refused when `signup_open` is false,
  unless an invite token accompanies it.
- [ ] **Commit:** `feat(admin): instance admin routes and kept admin CLI`.

---

## Phase E: jobs, alerts, seed (tasks 24–25)

### Task 24: pg-boss wiring, job policies and failed jobs (§3.1b, D166)

- [ ] **`jobs/boss.ts`:** a registry, `defineJob({name, kind: 'tenant'|'system', schedule?, policy:
  {retryLimit, retryBackoff, expireInSeconds}, handler})`.
  - A `tenant` job's payload carries `userId`, and the handler runs inside `withScope`.
  - A `system` job runs inside `withSystem`.
  - The policies come from engineering spec §3.1b.
- [ ] **Scheduling:** `boss.schedule` for `repair-orphans`, `expire-memberships`, and
  `audit-partitions` (creates next month's partition; system).
- [ ] **Failed jobs:**
  - `GET /api/v1/admin/jobs/failed` lists failed jobs, instance admin only.
  - `POST .../:id/retry` and `POST .../:id/discard`.
- [ ] **Tests:** a tenant job sees only its user's rows; a failing job lands in the failed list;
  retry works.
- [ ] **Commit:** `feat(jobs): pg-boss job registry, schedules and failed-jobs admin`.

### Task 25: Admin alerts framework (D166, D185)

- [ ] Table `admin_alerts(id, kind, dedupe_key UNIQUE, first_at, last_at, count, resolved_at,
  payload)`: instance scope, with RLS by `is_instance_admin()`, and system write.
- [ ] `raiseAlert(kind, dedupeKey, payload)` upserts the alert. It sends an email to the instance
  admins at most once per 24 h per key, through Mailpit in dev.
- [ ] First alert kind: `failed_jobs_rising`, raised when more than 5 jobs fail in 1 h. Checked by
  a system job every 15 min.
- [ ] Also `GET /api/v1/admin/alerts` and a status-page stub, `GET /api/v1/admin/status`, returning
  `{version, dbOk, alerts, recoveryKitAcknowledged}`.
- [ ] **Tests:** the alert is deduped; the email is sent once; it resolves.
- [ ] **Commit:** `feat(alerts): admin alerts with dedupe and email`.

### Task 26: Seed script skeleton (D152, D185)

- [ ] `kept admin seed --scenario households`. It is dev only, and refuses to run when
  `NODE_ENV=production`.
- [ ] It works through the service layer, not raw SQL, and creates:
  - an instance admin;
  - household 1 in English (Home; owner Ibrahim, admin Alfred, a member, a viewer, a managed child
    account, and an expiring member);
  - household 2 in Arabic (بيت العائلة, EGP, `ar-EG`).
- [ ] It prints the sign-in details to stdout (dev passwords).
- [ ] The e2e tests reuse it.
- [ ] **Test:** run it twice; the second run is a no-op. Commit: `feat(seed): household seed
  scenario`.

---

## Phase F: web shell, image, CI (tasks 27–30)

### Task 27: Spike S4 (V16) and the design system foundation (D131–D135, D190)

- [ ] **Create `apps/web`:**
  - Vite 8, React 19, TypeScript and Tailwind v4 (check the version on npm).
  - `react-aria-components`, TanStack Router (file routes) and TanStack Query.
  - Lingui 6 with the Vite plugin and PO catalogues for `en` and `ar`.
- [ ] **S4:** try shadcn's aria base.
  - Look up the current shadcn CLI and the "aria" base option in its docs with `npm view shadcn`;
    never guess flags.
  - If it installs cleanly and its components work in RTL, use it.
  - Otherwise, write the primitives directly on `react-aria-components`, and record that in the
    §19 V16 row.
- [ ] **Tokens:** copy the CSS tokens from `docs/design/kept-design-board.html` (the `:root`, dark
  and theme blocks) into `apps/web/src/styles/tokens.css`. Keep the names; D131 says the board is
  the source.
- [ ] **Fonts:** ship IBM Plex Sans, Plex Sans Arabic and Plex Mono in the image
  (`@fontsource/*` packages — check they exist), never from a CDN. They are OFL, and the licence
  allowlist must include OFL-1.1.
- [ ] **Theme before first paint:** an inline script in `index.html` reads `localStorage` inside a
  try/catch, sets `data-theme` and `dir`/`lang`, and falls back to `prefers-color-scheme`.
- [ ] **RTL:** logical CSS properties only. Biome can't lint this; add a small script,
  `scripts/check-logical-css.mjs`, that fails on `margin-left`, `padding-right`, `left:` and
  `right:` in `apps/web/src`.
- [ ] **About 8 primitives:** Button, TextField, PasswordField, Dialog, Combobox (never a native
  select; the no-native-controls rule), Switch, Toast (with an app-level `useConfirm`, never
  `window.confirm`), Card and Tabs.
  - Each gets a Vitest + Testing Library test: it renders, it can be operated from the keyboard,
    and it renders RTL with `dir="rtl"`.
- [ ] **Commit:** `feat(web): design tokens, fonts, i18n, RTL and primitives`.

### Task 28: Step-1 screens

- [ ] **Screens,** built to `docs/specs/2026-09-26-kept-screens.md` and the frames in
  `docs/design/kept-screens.html`:
  - First-run setup: code → account → done (D193: no recovery-kit gate).
  - Sign in: password, magic link, passkey.
  - Two-factor challenge and enrolment.
  - Magic-link confirm.
  - Home shell: sidebar or tab bar, the Personal card, "Create your first home", and the
    Get-started checklist with only the step-1 items; "Put Kept on HTTPS" first over http (D193).
  - New-location wizard (D194): name and kind → rooms → what to track.
  - Location settings → Members and roles, Invite (link + QR), and What to track.
  - Accept invite.
  - Account → sessions and devices.
  - Instance admin → users, settings, failed jobs, alerts, status.
  - The footer carries the version and the Source code link (D147).
- [ ] **API client:** generated from `/api/v1/openapi.json` with `openapi-typescript` (check it on
  npm), plus a small fetch wrapper that maps `{error, hint, code}`.
- [ ] **Playwright:** at phone (375×780) and desktop (1280×800) sizes, run setup → create home →
  invite → accept in a second browser context → the viewer sees the home. Use the seed from
  task 26.
- [ ] **Commit:** `feat(web): step-1 screens and e2e flow`.

### Task 29: Image and Compose (D147, D186, D193)

- [ ] **Dockerfile:**
  - Multi-stage on `node:24.21.0-bookworm-slim`. Look up the exact tag on Docker Hub; use a
    bookworm or trixie slim variant (glibc, for sharp later).
  - Build the web bundle and the server, and prune dev dependencies.
  - Run as a non-root uid 10001, with a read-only root filesystem and writable `/data` and
    `/config`.
  - OCI labels `org.opencontainers.image.source` and `revision` come from build arguments.
    `KEPT_SOURCE_URL` defaults from them.
  - `ENTRYPOINT ["node","apps/server/dist/main.js"]`, plus a `kept` CLI shim on the PATH.
- [ ] **`compose.yaml`** for self-hosters:
  - `db`: the pinned pgvector image, with the initdb script; production uses generated
    passwords from `.env`.
  - `migrate`: one-shot, runs `kept migrate`.
  - `kept`: waits for `migrate`, with volumes `kept-data:/data` and `kept-config:/config`.
  - Optional profile `https`, a reverse proxy. Pick the image and verify its tag on Docker Hub;
    Caddy is the transparent choice.
- [ ] **Smoke test:** `docker compose up`, then `/readyz` returns 200, the setup code appears in
  the logs, `/version` shows the source URL, and a second `up` prints no new code.
- [ ] **Commit:** `feat(image): production image and compose with first-boot keys`.

### Task 30: Local CI (§7.12, D151, D173, D187)

- [ ] **`scripts/ci-local.sh`** runs, with `set -euo pipefail`, each step's exit code gating:
  1. `pnpm install --frozen-lockfile`;
  2. `pnpm lint`;
  3. `pnpm typecheck`;
  4. `node scripts/check-logical-css.mjs`;
  5. `docker compose -f compose.dev.yaml up -d --wait`;
  6. `pnpm test`: unit + integration + leak + route catalogue;
  7. **migration drift:** `drizzle-kit generate` into a temp dir must produce no new migration,
     and `drizzle-kit check` must pass;
  8. **licence check:** `node scripts/check-licences.mjs` runs `pnpm licenses list --json --prod`
     against a runtime allowlist (MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0,
     OFL-1.1, MPL-2.0 (file-level), CC0-1.0, Unlicense), and uses a separate dev list;
  9. **attribution check:** `scripts/check-attribution.sh --range origin/main..HEAD`, falling back
     to the whole history the first time;
  10. **production-config run:** start the server with `NODE_ENV=production` and
      `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9` (a dead collector). `/readyz` must reach
      200 within 20 s (L90);
  11. **Playwright** e2e;
  12. **images:** `docker buildx build` for amd64 and arm64. The arm64 smoke test runs natively on
      this Apple Silicon laptop.
- [ ] **Route-catalogue test (D188):** list every registered non-GET route from Fastify's
  `printRoutes`/`routes` hook. For each, the test file must hold a case asserting that it writes an
  audit row, or the route must be on an explicit allowlist (auth handler, setup) with a reason.
- [ ] **`README.md`:** a short dev quickstart. Point to `docs/` for everything else.
- [ ] **Commit:** `chore(ci): local CI gate`. Then run `bash scripts/ci-local.sh` end to end. It
  must exit 0 before step 1 is declared done.

---

## Definition of done for step 1

- `bash scripts/ci-local.sh` exits 0.
- A fresh `docker compose up` goes from boot to setup to a Home screen in the browser, showing a
  Personal location and letting you create a home and invite someone.
- The leak test covers every table.
- Spike notes S1–S4 are written, and §19 V14, V16, V32 and V33 are updated with the results.
- The carry-over note `docs/plans/step-1-carryover.md` lists anything deferred, each with the step
  that takes it.
