import { ATTACHMENT_ROLES, DERIVED_STATES, SEMANTIC_STATES, VENDOR_KINDS } from '@kept/shared';
import { z } from 'zod';
import { requireScope } from '../auth/http.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { gateFor } from '../serialize/gates.js';
import { SearchQuery } from './query.js';
import {
  createView,
  deleteView,
  gateView,
  listViews,
  PrefsParams,
  prefsOf,
  putPrefs,
  SavedViewBody,
  SavedViewPatch,
  SavedViewPrefsBody,
  SavedViewPrefsSchema,
  SavedViewSchema,
  updateView,
  ViewsQuery,
} from './saved-views.js';
import { prepareSemantic } from './semantic.js';
import { search } from './service.js';

// Search, saved views and the ⌘K palette's backend (T20; D42, D174, D195; engineering spec
// §7.9; screens spec §5 Search and §8). The palette is the same route with `kind=things` and a
// small `limit` (apps/web/src/components/search/api.ts).
//
// GET /api/v1/search?q&locationId*&placeId*&typeId*&tagId*&state*&not*&kind&priceMin&priceMax
//   &currency&limit&cursor → {things: {items, next_cursor}, places, people, vendors,
//   documents: {items}, didYouMean, asOf}. `documents` (T21): attachments whose file's text
//   matches; a `snippet` only where the caller sees money, else `moneyHidden: true`. `*`: repeatable, "is any of"; `not` names those that are "is none of" (D205,
//   http/list-filters.ts).
// GET /api/v1/saved-views?surface&limit&cursor → {views, next_cursor, prefs} (≤100 a page; prefs
//   {defaultViewId, pinned} with a surface, else null)
// POST /api/v1/saved-views {surface?, name, query, …} (at most 100 of one's own: 409 reason
//   'limit'), PATCH (If-Match)|DELETE /api/v1/saved-views/:id
// PUT /api/v1/saved-views/prefs/:surface {defaultViewId, pinned} → {defaultViewId, pinned}

const Iso = z.string();

const PathStep = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
  shortCode: z.string().nullable().optional(),
});

/** The thing row of the web contract (ThingRow). It has no money field: nothing to gate. */
const ThingRow = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  shortCode: z.string().nullable(),
  name: z.string().nullable(),
  type: z
    .object({
      id: z.uuid(),
      icon: z.string(),
      name: z.string().nullable(),
      builtinKey: z.string().nullable(),
    })
    .nullable(),
  quantity: z.number(),
  lifecycle: z.string(),
  derivedState: z.array(z.enum(DERIVED_STATES)),
  path: z.array(PathStep),
  containerThumbUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  lastSeenAt: Iso.nullable(),
  isContainer: z.boolean(),
  matchedAlias: z.string().optional(),
  /** Found by meaning alone (step-6 T14). */
  matchedBy: z.literal('meaning').optional(),
});

const SearchResponse = z.object({
  things: z.object({ items: z.array(ThingRow), next_cursor: z.string().nullable() }),
  places: z.array(
    z.object({
      id: z.uuid(),
      locationId: z.uuid(),
      name: z.string(),
      kindKey: z.string(),
      icon: z.string().nullable(),
      path: z.array(PathStep),
    }),
  ),
  people: z.array(z.object({ id: z.uuid(), displayName: z.string(), ownerAccountId: z.uuid() })),
  vendors: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.enum(VENDOR_KINDS),
      ownerAccountId: z.uuid(),
    }),
  ),
  documents: z.object({
    items: z.array(
      z.object({
        attachmentId: z.uuid(),
        fileId: z.uuid(),
        locationId: z.uuid(),
        subject: z.object({
          kind: z.enum(['thing', 'place', 'purchase', 'meter_reading', 'incident', 'location']),
          id: z.uuid(),
          name: z.string().nullable(),
        }),
        role: z.enum(ATTACHMENT_ROLES),
        snippet: z.string().optional(),
        moneyHidden: z.literal(true).optional(),
      }),
    ),
  }),
  didYouMean: z.array(z.string()),
  asOf: Iso,
  /** Why things were found by keywords only (step-6 T14, §7.15); null: meaning searched too. */
  semantic: z
    .object({ state: z.enum(SEMANTIC_STATES), until: Iso.optional() })
    .nullable()
    .optional(),
});

const Params = z.object({ id: z.uuid() });

export async function searchRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/search',
    { schema: { querystring: SearchQuery, response: { 200: SearchResponse } } },
    async (req) => {
      // The query's embedding first, outside the search's transaction (D166; step-6 T14).
      const q = req.query;
      const semantic =
        !q.cursor && (!q.kind || q.kind === 'things')
          ? await prepareSemantic({ pools, ai: deps.ai, log: req.log }, requireScope(req), q.q, {
              locationIds: q.locationId ?? [],
              not: q.not?.includes('locationId') ?? false,
            })
          : null;
      return scopedRead(pools, req, (tx, client, scope) =>
        search(tx, client, scope, deps.files, q, semantic),
      );
    },
  );

  app.get(
    '/api/v1/saved-views',
    {
      schema: {
        querystring: ViewsQuery,
        response: {
          200: z.object({
            views: z.array(SavedViewSchema),
            next_cursor: z.string().nullable(),
            prefs: SavedViewPrefsSchema.nullable(),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        const gateOf = (locationId: string) => gateFor(tx, locationId, scope);
        const page = await listViews(client, scope.userId, req.query);
        const views = [];
        for (const v of page.items) views.push(await gateView(v, gateOf));
        const prefs = req.query.surface ? await prefsOf(client, req.query.surface) : null;
        return { views, next_cursor: page.next_cursor, prefs };
      }),
  );

  app.put(
    '/api/v1/saved-views/prefs/:surface',
    {
      schema: {
        params: PrefsParams,
        body: SavedViewPrefsBody,
        response: { 200: SavedViewPrefsSchema },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await putPrefs(tx, client, scope.userId, req.params.surface, req.body, req.id),
      })),
  );

  app.post(
    '/api/v1/saved-views',
    { schema: { body: SavedViewBody, response: { 201: SavedViewSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createView(tx, client, scope.userId, req.body, req.id),
      })),
  );

  app.patch(
    '/api/v1/saved-views/:id',
    { schema: { params: Params, body: SavedViewPatch, response: { 200: SavedViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateView(
          tx,
          client,
          scope.userId,
          req.params.id.toLowerCase(),
          expected,
          req.body,
          req.id,
        ),
      }));
    },
  );

  app.delete('/api/v1/saved-views/:id', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteView(tx, client, scope.userId, req.params.id.toLowerCase(), req.id);
      return { status: 204, body: undefined };
    }),
  );
}
