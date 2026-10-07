---
title: Build a feature end to end
description: A walk through every layer a feature touches, from the migration to the screen, traced on a real feature.
---

This page follows one real, small feature through the code: **"Keep at least N"** on a
consumable (step 7, D14). A person sets a minimum on a thing such as a pack of AA batteries, the
Consumables list shows what is running low, and Adjust changes the quantity. It touches every
layer: a new table, row-level security, a service and routes, the audit log, the MCP tool set, a
web screen, five catalogues and tests at each step. Use it as a map for your own feature, and
open the files as you go.

| Layer | Files |
|---|---|
| Shared constants | `packages/shared/src/consumables.ts`, `packages/shared/src/errors.ts` |
| Schema and migrations | `apps/server/src/db/schema/consumables.ts`, `apps/server/migrations/0084_consumables.sql`, `0085_consumables_fields_rls.sql` |
| Leak test fixture | `apps/server/test/leak-portability.ts` |
| Service and routes | `apps/server/src/consumables/service.ts`, `routes.ts`, `undo.ts` |
| MCP tool | `packages/mcp/src/tools.ts` (`adjust_stock`), `apps/server/src/tools/handlers/consumables.ts` |
| Web API | `apps/web/src/api/portability/paths.ts`, `types.ts`, `queries.ts`, `mock/consumables.ts` |
| Web screen | `apps/web/src/routes/_app/consumables.tsx`, `apps/web/src/components/consumables/` |
| Tests | `apps/server/src/db/consumables.test.ts`, `apps/server/src/consumables/consumables.test.ts`, `apps/web/src/test/screens/consumables.test.tsx`, `apps/web/e2e/step7.spec.ts` |

## 1. Shared constants

Anything both the server and the web app need lives in `packages/shared`: here the upper bound
`STOCK_MIN_MAX`, the rule `isLow(quantity, min)`, and the error code `not_consumable` with its
English sentence in `packages/shared/src/errors.ts`. Request and response schemas stay with the
route that serves them; the web app has its own types in `apps/web/src/api/<area>/types.ts`.
Contracts both sides must parse identically, such as the sync queue, are the exception and live
in `packages/shared` as zod schemas.

## 2. The table and its migration

Write the table in Drizzle under `apps/server/src/db/schema/`, export it from the schema index,
and generate the migration with the owner login exported:

```ts title="apps/server/src/db/schema/consumables.ts"
export const stockRules = pgTable(
  'stock_rules',
  {
    id: id(),
    thingId: uuid('thing_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    minQuantity: numeric('min_quantity', { precision: 12, scale: 3 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [unique('stock_rules_thing_uq').on(t.thingId) /* , checks, foreign keys, index */],
);
```

```sh
cd apps/server && pnpm exec drizzle-kit generate --name=consumables
```

`mutable()` adds `created_at`, `updated_at`, `row_version` and `change_seq`. Enumerations are
`text` with a `CHECK`, never Postgres enums. Migrations are additive: dropping or renaming takes
two releases. See [Migrations](/developers/migrations/).

## 3. Row-level security

Drizzle writes tables; policies, grants and triggers are a **custom migration** you write by hand
into the file `drizzle-kit generate --custom --name=<what_it_does>` creates. Every owned table
forces RLS and gives `kept_app` policies scoped by location:

```sql title="apps/server/migrations/0085_consumables_fields_rls.sql"
ALTER TABLE public.stock_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_select ON public.stock_rules FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.stock_rules FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.stock_rules
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
```

The real file also has the insert and update policies, the column grant for updates and the
consumable guard. See [Row-level security](/developers/rls/).

**The leak test** fails until the new table has RLS, policies, a scope column and fixture rows.
Add rows to the matching `apps/server/test/leak-*.ts` file; here, a pack of batteries with a rule
in `leak-portability.ts`. Run `pnpm --filter @kept/server kept migrate` against your development
database, then the leak test.

## 4. The service and the routes

Each feature owns a folder in `apps/server/src/<feature>/`. The service does the work inside the
caller's scoped transaction; the routes validate and delegate:

```ts title="apps/server/src/consumables/routes.ts"
app.put(
  '/api/v1/things/:id/stock-rule',
  {
    config: byThing,
    schema: { params: Params, body: PutBody, response: { 200: StockRuleSchema } },
  },
  (req, reply) => {
    const expected = req.headers['if-match'] ? requireIfMatch(req) : undefined;
    return write(req, reply, 200, (ctx) =>
      putStockRule(ctx, lower(req.params.id), expected, req.body.minQuantity),
    );
  },
);
```

- `scopedRead` and `scopedWrite` (`apps/server/src/http/write.ts`) run the handler as `kept_app`
  with the caller's scope set, so RLS applies to every query.
- `config: { module: 'consumables' }` gates the routes on the location's module: a read is 404
  `module_off`, a write 409.
- Edits send `If-Match` with the `row_version` they started from; a mismatch is 412.
- Errors are `AppError` with a code from `ErrorCode`. A database constraint can map to its own
  code in the `CODED` table of `apps/server/src/http/errors.ts`
  (`stock_rules_consumable` → `not_consumable`).

**Register the module** by adding `consumableRoutes` to `INVENTORY_ROUTE_MODULES` in
`apps/server/src/http/routes.ts`; add new routes in the feature's own file, never there. A route
is closed to personal tokens unless it is listed in `apps/server/src/tokens/access.ts`.

## 5. The audit entry

Every write leaves an audit row, written in the same transaction with `audited()`:

```ts title="apps/server/src/consumables/service.ts"
await audited(ctx.tx, {
  locationId: thing.location_id,
  actor: actorOf(ctx.scope),
  action: 'thing.stock_rule',
  entity: { type: 'thing', id: thing.id },
  before: { min_quantity: before },
  after: { min_quantity: after },
  rootThingId: thing.id,
  subjects: [thing.id],
  requestId: ctx.requestId,
  undoableUntil: undoableUntil(),
});
```

`undo.ts` registers how to undo the action. The web app names the action in History through
`apps/web/src/components/history/labels.ts` (`'thing.stock_rule': t\`Minimum to keep changed\``).

## 6. OpenAPI, for free

The server registers `@fastify/swagger` with the zod type provider, so a route's `schema` is its
documentation. `GET /api/v1/openapi.json` serves it, and the docs build regenerates the
[API reference](/api/) from it (`pnpm --filter @kept/docs gen:openapi`). There is nothing to edit.

## 7. The MCP tool, if the action fits one

Adjusting stock is an everyday write, so it is also the `adjust_stock` tool: a contract in
`packages/mcp/src/tools.ts` with `module: 'consumables'`, and a handler that calls the same
`adjustStock` service. See [MCP server](/developers/mcp/#adding-a-tool).

## 8. The web API and its mock

- **Paths:** `apps/web/src/api/portability/paths.ts` holds every path once, plus a
  `PORTABILITY_METHODS` table that a test checks against the server's routes.
- **Calls and hooks:** `queries.ts` has `portabilityApi.putStockRule(…)` (sending `If-Match`) and
  TanStack Query hooks, `useStockRule(thingId)` and `useConsumables(params)`, an infinite query
  that follows `next_cursor`. After a write, invalidate the query keys the change affects.
- **The mock:** `apps/web/src/api/portability/mock/consumables.ts` answers the same paths in
  memory, with the same rules (low first, never below 0, undoable), so screen tests run without a
  server.

## 9. The screen

```tsx title="apps/web/src/routes/_app/consumables.tsx"
export const Route = createFileRoute('/_app/consumables')({
  validateSearch: listSearch(['location', 'state']),
  component: ConsumablesPage,
  errorComponent: ConsumablesRouteError,
});
```

- The route file declares its URL state with `listSearch`; the list reads it with
  `useListState()`.
- `StockList` (`components/consumables/stock-list.tsx`) is a `ListSurface`: search, filters,
  grouping and Load more, all in the URL. See [UI kit](/developers/ui-kit/).
- It reads only the server, so its chunk is on demand: the route is in `HOUSEHOLD_ROUTES` and the
  Adjust sheet in `HOUSEHOLD_SECTIONS` in `apps/web/vite.config.ts`, and its error component says
  "Needs a connection" offline. See [Offline and sync](/developers/offline-sync/#screens-that-need-a-connection).
- Controls are React Aria components; a confirmation is `useConfirm()`, never `window.confirm`.

## 10. Strings, in five languages

Every string goes through Lingui and into `en`, `ar`, `fr`, `de` and `it`, with Arabic written
natively and every plural form. Names inside sentences are isolated: the Adjust sheet's title is
`Adjust ⁨AA batteries⁩`, built with `isolate()` from `lib/bidi.ts`. Separators come from
`fmt.sep`. See [Languages and right-to-left](/developers/i18n-rtl/).

## 11. Tests at each layer

| Layer | Test | What it proves |
|---|---|---|
| Database | `apps/server/src/db/consumables.test.ts` | The policies and the consumable guard, as members and viewers |
| Leak | `apps/server/test/leak.test.ts` | No other location's rule is readable |
| Service and routes | `apps/server/src/consumables/consumables.test.ts` | Behaviour, the audit row and undo; each write case carries its `// catalogue: PUT /api/v1/things/:id/stock-rule` marker |
| MCP | `apps/server/src/tools/tools.test.ts`, `packages/mcp/src/tools.test.ts` | The tool and its place in the table |
| Web contract | `apps/web/src/api/portability/mock/mock.test.ts` | Every path and method the web uses exists |
| Screen | `apps/web/src/test/screens/consumables.test.tsx` | Low first, Adjust with Undo, viewer, module off, offline, Arabic, and `expectLogicalOnly()` |
| End to end | `apps/web/e2e/step7.spec.ts` | Low on Home and in Consumables, and Adjust fixes it |

See [Testing](/developers/testing/).

## 12. The gate

```sh
bash scripts/ci-local.sh --fast       # lint, catalogues, typecheck, unit, eval
pnpm exec vitest run --project @kept/server apps/server/src/consumables
bash scripts/ci-local.sh              # the full gate, before a database change lands
```

`--fast` catches missing strings, physical CSS and type errors; the `test` and `drift` steps
catch a policy you forgot and a schema that doesn't match its migrations. A web change also needs
`pnpm --filter @kept/web build`, which runs the bundle and precache check.
