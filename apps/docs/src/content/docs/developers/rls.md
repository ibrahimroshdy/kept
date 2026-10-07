---
title: Row-level security
description: Kept's database roles, how a request sets its scope, the shapes the policies take, and the leak test that holds every table to them.
---

Kept's tenancy is enforced by Postgres, not only by the application. Every request runs as a role
that cannot bypass row-level security, inside a transaction that names its user, and every table
has policies that read that name. A query that forgot to filter, or ran without a scope, returns
nothing. The design is the engineering spec's §1.1, §7.1, §7.2 and §7.14
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)).

## The roles

<figure class="kd-diagram">
<svg viewBox="0 0 760 266" role="img" aria-labelledby="d-roles-t" dir="ltr">
<title id="d-roles-t">Who connects as which role, and what it reaches</title>
<defs><marker id="d-roles-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kd-head" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="kd-box" x="20" y="20" width="190" height="46" rx="6"/>
<text class="kd-t" x="115" y="48" text-anchor="middle">kept migrate · kept admin</text>
<rect class="kd-box" x="20" y="80" width="190" height="46" rx="6"/>
<text class="kd-t" x="115" y="108" text-anchor="middle">Requests, tenant jobs</text>
<rect class="kd-box" x="20" y="140" width="190" height="46" rx="6"/>
<text class="kd-t" x="115" y="168" text-anchor="middle">Better Auth</text>
<rect class="kd-box" x="20" y="200" width="190" height="46" rx="6"/>
<text class="kd-t" x="115" y="228" text-anchor="middle">System jobs, pg-boss</text>
<rect class="kd-box kd-sunken" x="265" y="20" width="200" height="46" rx="6"/>
<text class="kd-t kd-mono" x="365" y="40" text-anchor="middle">kept_owner</text>
<text class="kd-t2" x="365" y="57" text-anchor="middle">no pool, one connection</text>
<rect class="kd-box kd-accent" x="265" y="80" width="200" height="46" rx="6"/>
<text class="kd-t kd-mono kd-on-accent" x="365" y="100" text-anchor="middle">kept_app</text>
<text class="kd-t2 kd-on-accent" x="365" y="117" text-anchor="middle">pools.app, NOBYPASSRLS</text>
<rect class="kd-box" x="265" y="140" width="200" height="46" rx="6"/>
<text class="kd-t kd-mono" x="365" y="160" text-anchor="middle">kept_auth</text>
<text class="kd-t2" x="365" y="177" text-anchor="middle">pools.auth</text>
<rect class="kd-box" x="265" y="200" width="200" height="46" rx="6"/>
<text class="kd-t kd-mono" x="365" y="220" text-anchor="middle">kept_system</text>
<text class="kd-t2" x="365" y="237" text-anchor="middle">pools.system</text>
<rect class="kd-box" x="520" y="20" width="220" height="46" rx="6"/>
<text class="kd-t2" x="630" y="48" text-anchor="middle">owner_all: owns every schema</text>
<rect class="kd-box" x="520" y="80" width="220" height="46" rx="6"/>
<text class="kd-t2" x="630" y="100" text-anchor="middle">withScope(): app.user_id</text>
<text class="kd-t2" x="630" y="117" text-anchor="middle">→ that user's locations</text>
<rect class="kd-box" x="520" y="140" width="220" height="46" rx="6"/>
<text class="kd-t2" x="630" y="168" text-anchor="middle">schema auth only</text>
<rect class="kd-box" x="520" y="200" width="220" height="46" rx="6"/>
<text class="kd-t2" x="630" y="220" text-anchor="middle">withSystem(): system_*</text>
<text class="kd-t2" x="630" y="237" text-anchor="middle">policies on listed tables</text>
<path class="kd-edge" d="M210 43H265" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M210 103H265" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M210 163H265" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M210 223H265" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M465 43H520" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M465 103H520" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M465 163H520" marker-end="url(#d-roles-a)"/>
<path class="kd-edge" d="M465 223H520" marker-end="url(#d-roles-a)"/>
</svg>
<figcaption>Three runtime logins, one pool each; the owner login is used only by the one-shot commands and the nightly backup.</figcaption>
</figure>

| Role | Used by | May do |
|---|---|---|
| `kept_owner` | `kept migrate`, `kept admin`, and the worker's backup dump when a target is set | Owns schemas `public`, `kept`, `auth` and `pgboss`. RLS is **forced** on its tables too; it reaches rows through each table's `owner_all` policy. Never in a pool or a request |
| `kept_app` | Every request (`pools.app`), tenant jobs, instance-admin routes | DML on the app tables, only through `app_*` policies; may only send pg-boss jobs. Has a 15 s statement timeout and a 30 s idle-in-transaction timeout |
| `kept_auth` | Better Auth (`pools.auth`) | DML on `auth.*` only; no USAGE on `public` or `kept` |
| `kept_system` | System jobs and pg-boss (`pools.system`), the setup code at boot | Only the tables whose `system_*` policies name it, each commented with the job it serves |
| `postgres` (superuser) | The database's first start, and the tests' global setup | Creates the four logins and the extensions. Kept never connects as it at runtime |

All four logins are `NOSUPERUSER NOCREATEROLE NOBYPASSRLS`; `test/roles.test.ts` checks it on the
development database. The SQL that makes them is
[`docker/initdb/01-roles.sql`](https://github.com/ibrahimroshdy/kept/blob/main/docker/initdb/01-roles.sql)
in development and
[`docker/initdb-prod/01-roles.sh`](https://github.com/ibrahimroshdy/kept/blob/main/docker/initdb-prod/01-roles.sh)
in production; for a managed database, see [managed Postgres](/install/managed-postgres/).
Everything else (schemas, grants, policies) comes from the migrations, so every database gets the
same privileges however it was made.

## How a request sets its scope

[`db/scope.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/db/scope.ts) is
the only way to query as a user. `withScope(pool, scope, fn)` takes a `kept_app` connection and
runs:

```sql
BEGIN;
SELECT set_config('app.user_id', $1, true),
       set_config('app.mfa', $2, true),
       set_config('app.token_id', $3, true);
-- fn(tx, client): the route's queries, its audit row, any job it sends
COMMIT;
RESET app.user_id; RESET app.mfa; RESET app.token_id;
```

The third argument `true` makes each setting transaction-local. The `RESET` after commit guards
against a value set session-wide by mistake before the connection goes back to the pool. Inside
the scope, Drizzle's `transaction()` throws: a nested `BEGIN` would commit the scope early.
`withSystem(pool, fn)` does the same with all three empty, on `kept_system`.

The policies read the settings through `kept.current_user_id()`, `kept.current_mfa()` and
`kept.current_token_id()`. Unset, the user id is null, every membership function returns
nothing, and every policy denies: **fail closed**.

`app.mfa` is whether this session proved a second factor; locations with `require_2fa` stay
hidden while it is false. `app.token_id` is set when the request came with a personal token or
an OAuth grant; the location functions then intersect the creator's memberships with the token's
locations, and a read token has nothing writable
([`0070_tokens_rls.sql`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/migrations/0070_tokens_rls.sql)).

## Policy shapes

Scopes (spec §1.1): **location** (most tables), **account** (the registries: types, brands,
vendors, people, tags, place kinds), **user** (profiles, channels, tokens, assistant threads) and
**instance** (instance settings, backup runs). The membership functions are `SECURITY DEFINER`,
`STABLE`, owned by `kept_owner` with a fixed `search_path`
([`0006_rls.sql`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/migrations/0006_rls.sql)):

| Function | Returns |
|---|---|
| `kept.visible_location_ids()` | Active, unexpired memberships, location not in deletion grace, `require_2fa` only with `app.mfa` |
| `kept.writable_location_ids()` | The same, minus viewers |
| `kept.admin_location_ids()` | Owners and admins |
| `kept.visible_account_ids()` and siblings | The owner accounts of those locations |
| `kept.is_instance_admin()` | Whether `app.user_id` is in `instance_admins`, and never for a token |

A location-scoped table gets this shape, on both `USING` and `WITH CHECK`:

```sql
CREATE POLICY app_select ON public.places FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_update ON public.places FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
```

A user-scoped one compares `user_id = (SELECT kept.current_user_id())`. Wrapping each call in a
sub-`SELECT` makes Postgres evaluate it once per statement, not once per row. The policies keep
viewers from writing as defence in depth; the finer rules are `can(role, action)` in
[`packages/shared/src/roles.ts`](https://github.com/ibrahimroshdy/kept/blob/main/packages/shared/src/roles.ts),
checked by the services.

What a policy can't express goes through a `SECURITY DEFINER` function ("door") that checks its
caller and does one thing: accepting an invite, deleting a location, a thing's purchase line
after a move, and the search doors. Views are `security_invoker`. Files are visible only through
an `attachments` row you can see.

:::caution[EXPLAIN as kept_app]
Full-text `@@`, trigram `%`, `ILIKE` and JSON containment aren't leakproof, so under a policy
Postgres won't use them as an index condition, and a search scans every visible row. Kept routes
such matches through definer doors (`kept.search_thing_ids()`, migration 0030). Check any new
query over a large table with `EXPLAIN` **as `kept_app`**, never as the owner, which shows a plan
the app never gets. The measurements are in
[the RLS benchmark](https://github.com/ibrahimroshdy/kept/blob/main/docs/perf/2026-09-26-rls-bench.md).
:::

## The leak test

[`apps/server/test/leak.test.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/test/leak.test.ts)
is generated from the catalogue (`pg_class`, `pg_policies`, `information_schema`), so **a new
table is covered without editing it, and fails it until it has RLS, policies, a scope column and
fixture rows.** It checks, among others:

- every table in `public` has RLS forced, an `owner_all` policy and a `kept_app` policy; no
  policy is granted `TO public`; views are `security_invoker`;
- every table has a scope column (`location_id`, `owner_account_id` or `user_id`), its own id as
  scope, or a listed reason not to;
- `kept_system` has policies on exactly the listed system tables, and reads, changes and writes
  nothing else; `kept_auth` has nothing outside `auth`;
- the runtime roles may execute exactly the listed functions, and `kept_app` may update no id,
  key or scope column;
- on the request path, for each attacker (another tenant, an expired member, a member of a
  `require_2fa` location without a second factor, a viewer), none of the victim's rows is counted,
  updated, deleted or copied, and every definer door is probed;
- a client-supplied id that exists in another tenant answers exactly like one that exists
  nowhere.

The fixtures live beside it (`test/leak-inventory.ts`, `leak-household.ts`, `leak-vehicles.ts`,
`leak-capture.ts`, `leak-assistant.ts`, `leak-operations.ts`, `leak-portability.ts`): put rows for
your new table in the one for its area. Adding to an exception list is a decision a reviewer
should see. Run it with the development database up:

```sh
pnpm test apps/server/test/leak.test.ts
```

Behaviour of individual policies is tested in `apps/server/src/db/rls.test.ts` and the area tests
next to it.
