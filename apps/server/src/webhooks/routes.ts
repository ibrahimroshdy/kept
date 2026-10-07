import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_DISABLED_REASONS, WEBHOOK_EVENTS } from '@kept/shared';
import { z } from 'zod';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { KeptApp } from '../http/app.js';
import { paginate, paginationQuery, requireIfMatch } from '../http/conventions.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { sendTestPing } from './deliver.js';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testableWebhook,
  updateWebhook,
} from './service.js';

// Location webhooks (step-6 plan T15; engineering spec §2.6; D63, D110, D180). The web's
// contract is apps/web/src/api/connections/{paths,types}.ts and its mock.
//
// GET    /api/v1/locations/:id/webhooks          → {items: WebhookRow[]} (never a secret)
// POST   /api/v1/locations/:id/webhooks          {url, events} → 201 {webhook, secret} (once)
// PATCH  /api/v1/webhooks/:id  (If-Match)        {url?, events?, active?} → WebhookRow
// POST   /api/v1/webhooks/:id/rotate-secret      → {secret} (once)
// POST   /api/v1/webhooks/:id/test               → {httpStatus} (a ping, now; 6 a minute)
// DELETE /api/v1/webhooks/:id                    → 204
// GET    /api/v1/webhooks/:id/deliveries?cursor  → {items, next_cursor} (the last 30 days)
//
// `webhooks.manage` (owner and admin) on every route; closed to tokens (Q20: no catalogue
// `tokens` entry). A location the caller can't see is a 404, one they see but don't administer
// a 403 (service.ts).

/** Test pings a person may send a minute, every hook together (plan T15). */
export const TESTS_PER_MINUTE = 6;

const Iso = z.iso.datetime({ offset: true });

const WebhookSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  active: z.boolean(),
  failingSince: Iso.nullable(),
  disabledReason: z.enum(WEBHOOK_DISABLED_REASONS).nullable(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
  lastDelivery: z
    .object({
      status: z.enum(WEBHOOK_DELIVERY_STATUSES),
      at: Iso,
      httpStatus: z.number().int().nullable(),
    })
    .optional(),
  rowVersion: z.number().int(),
});

const DeliverySchema = z.object({
  id: z.uuid(),
  event: z.enum([...WEBHOOK_EVENTS, 'ping']),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int(),
  httpStatus: z.number().int().nullable(),
  createdAt: Iso,
  nextAttemptAt: Iso.nullable(),
});

const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);

const CreateBody = z.object({ url: z.string().min(1).max(500), events: Events }).strict();

const UpdateBody = z
  .object({
    url: z.string().min(1).max(500).optional(),
    events: Events.optional(),
    active: z.boolean().optional(),
  })
  .strict();

const IdParams = z.object({ id: z.uuid() });

function keysOf(deps: InventoryDeps): SecretKeys {
  if (!deps.secretKeys) {
    throw new AppError('internal', 503, 'Secret values are not configured on this server.');
  }
  return deps.secretKeys;
}

/** A one-time secret is never stored in the idempotency row: a replay says it was done. */
const redactSecret = (body: unknown) => ({ ...(body as object), secret: '' });

export async function webhookRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/locations/:id/webhooks',
    {
      schema: { params: IdParams, response: { 200: z.object({ items: z.array(WebhookSchema) }) } },
    },
    (req) => scopedRead(pools, req, (_tx, client) => listWebhooks(client, req.params.id)),
  );

  app.post(
    '/api/v1/locations/:id/webhooks',
    {
      schema: {
        params: IdParams,
        body: CreateBody,
        response: { 201: z.object({ webhook: WebhookSchema, secret: z.string() }) },
      },
    },
    async (req, reply) => {
      const master = keysOf(deps).get().current;
      const allowPrivate = await allowPrivateAddresses(pools);
      return scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => ({
          status: 201,
          body: await createWebhook(
            { tx, client, scope, requestId: req.id },
            master,
            req.params.id,
            req.body,
            allowPrivate,
          ),
        }),
        { redact: redactSecret },
      );
    },
  );

  app.patch(
    '/api/v1/webhooks/:id',
    { schema: { params: IdParams, body: UpdateBody, response: { 200: WebhookSchema } } },
    async (req, reply) => {
      const expected = requireIfMatch(req);
      const allowPrivate = await allowPrivateAddresses(pools);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateWebhook(
          { tx, client, scope, requestId: req.id },
          req.params.id,
          expected,
          req.body,
          allowPrivate,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/webhooks/:id/rotate-secret',
    { schema: { params: IdParams, response: { 200: z.object({ secret: z.string() }) } } },
    (req, reply) => {
      const master = keysOf(deps).get().current;
      return scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => ({
          status: 200,
          body: await rotateWebhookSecret(
            { tx, client, scope, requestId: req.id },
            master,
            req.params.id,
          ),
        }),
        { redact: redactSecret },
      );
    },
  );

  app.post(
    '/api/v1/webhooks/:id/test',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ httpStatus: z.number().int().nullable() }) },
      },
    },
    async (req, reply) => {
      const keys = keysOf(deps);
      const hook = await scopedRead(pools, req, (_tx, client) =>
        testableWebhook(client, req.params.id),
      );
      const limit = await reserveInWindow(
        pools.auth,
        limiterKey('webhook-test', requireScope(req).userId),
        TESTS_PER_MINUTE,
        60,
      );
      if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
      return sendTestPing({ pools, keyring: () => keys.get().keyring }, hook);
    },
  );

  app.delete('/api/v1/webhooks/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteWebhook({ tx, client, scope, requestId: req.id }, req.params.id);
      return { status: 204, body: undefined };
    }),
  );

  app.get(
    '/api/v1/webhooks/:id/deliveries',
    {
      schema: {
        params: IdParams,
        querystring: paginationQuery,
        response: {
          200: z.object({ items: z.array(DeliverySchema), next_cursor: z.string().nullable() }),
        },
      },
    },
    (req) => {
      const page = paginate<string>(req.query);
      if (page.after !== null && !z.uuid().safeParse(page.after).success) {
        throw invalid('The cursor is not valid; start again from the first page.');
      }
      return scopedRead(pools, req, (_tx, client) => listDeliveries(client, req.params.id, page));
    },
  );
}
