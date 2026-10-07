import { NOTIFY_KINDS, PREFERENCE_CHANNELS, ROLES } from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { KeptApp } from '../http/app.js';
import { AppError, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { logMailer } from '../mail/mailer.js';
import {
  createWebhook,
  deleteChannel,
  deleteSubscription,
  ensureEmailChannel,
  mailIdentity,
  myChannels,
  type NotifyDeps,
  testEmailSend,
  testPushSend,
  testWebhookSend,
  upsertSubscription,
} from './channels.js';
import {
  aiSummaryEmail,
  kindsFor,
  myLocations,
  myPreferences,
  myTiming,
  putPreferences,
  storedMap,
  updateTiming,
} from './prefs.js';

// Channels, push subscriptions and preferences (step-4 plan T15; D29, D30, D122, D139; Q8–Q13,
// Q35). The web's contract is apps/web/src/api/household/{types,paths}.ts (NotificationSettings,
// Channel, …) and its mock (mock/notify.ts).
//
// GET    /api/v1/me/notification-settings        → NotificationSettings
// PUT    /api/v1/me/notification-settings        {digestTime?, quietFrom?, quietTo?} → the same
// PUT    /api/v1/me/notification-preferences     {items: [...] (≤ 200)} → the same settings
// POST   /api/v1/me/channels                     {kind: 'webhook', url, label?} → 201 {channel, secret}
// DELETE /api/v1/me/channels/:id                 → 204 (the email channel: 400)
// POST   /api/v1/me/channels/:id/test            → {ok, status?, error?}
// POST   /api/v1/me/push-subscriptions           {endpoint, keys, label?} → 201 {id}
// DELETE /api/v1/me/push-subscriptions/:id       → 204
// POST   /api/v1/me/push-subscriptions/:id/test  → {ok, status?, error?}
//
// Everything here is the caller's own: another person's channel or device is a 404. A test send
// is synchronous (the person waits for the answer) and limited to TESTS_PER_HOUR, every channel
// together.

/** Test sends a person may make an hour, every channel together (plan T15). */
export const TESTS_PER_HOUR = 5;

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const Iso = z.iso.datetime({ offset: true });

const ChannelSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['email', 'webpush', 'webhook']),
  label: z.string().nullable(),
  displayHost: z.string().nullable(),
  verifiedAt: Iso.nullable(),
  failingSince: Iso.nullable(),
  subscriptions: z
    .array(
      z.object({
        id: z.uuid(),
        label: z.string().nullable(),
        createdAt: Iso,
        lastSuccessAt: Iso.nullable(),
      }),
    )
    .optional(),
});

const KindPreferenceSchema = z.object({
  inapp: z.boolean(),
  email: z.boolean(),
  webpush: z.boolean(),
  webhook: z.boolean(),
  isDefault: z.boolean(),
});

const SettingsSchema = z.object({
  timezone: z.string(),
  digestTime: TIME,
  quietFrom: TIME.nullable(),
  quietTo: TIME.nullable(),
  smtpConfigured: z.boolean(),
  push: z.object({
    available: z.boolean(),
    publicKey: z.string().nullable(),
    reason: z.enum(['no_https', 'no_subject']).optional(),
  }),
  channels: z.array(ChannelSchema),
  locations: z.array(
    z.object({
      locationId: z.uuid(),
      name: z.string(),
      role: z.enum(ROLES),
      kinds: z.partialRecord(z.enum(NOTIFY_KINDS), KindPreferenceSchema),
    }),
  ),
  account: z.object({ aiSummary: z.object({ email: z.boolean() }) }),
});
type Settings = z.infer<typeof SettingsSchema>;

const PutSettingsBody = z
  .object({
    digestTime: TIME.optional(),
    quietFrom: TIME.nullable().optional(),
    quietTo: TIME.nullable().optional(),
  })
  .strict();

const PutPreferencesBody = z
  .object({
    items: z
      .array(
        z
          .object({
            locationId: z.uuid().nullable(),
            kind: z.enum(NOTIFY_KINDS),
            channel: z.enum(PREFERENCE_CHANNELS),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

const CreateChannelBody = z
  .object({
    kind: z.literal('webhook'),
    url: z.string().min(1).max(2000),
    label: z.string().max(60).optional(),
  })
  .strict();

const SubscriptionBody = z
  .object({
    endpoint: z
      .string()
      .max(1000)
      .regex(/^https:\/\//, 'an https address'),
    keys: z
      .object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) })
      .strict(),
    label: z.string().max(60).optional(),
  })
  .strict();

const TestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  error: z.string().optional(),
});

const IdParams = z.object({ id: z.uuid() });

/** The deps these routes use: the app's, or quiet defaults for an app built without them. */
function notifyOf(deps: InventoryDeps): NotifyDeps {
  return deps.notify ?? { push: null, mailer: logMailer(deps.log), mailConfigured: false };
}

function keysOf(deps: InventoryDeps): SecretKeys {
  if (!deps.secretKeys) {
    throw new AppError('internal', 503, 'Secret values are not configured on this server.');
  }
  return deps.secretKeys;
}

export async function channelRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const notify = notifyOf(deps);

  async function settingsOf(client: pg.ClientBase, userId: string): Promise<Settings> {
    const who = await mailIdentity(pools, client, userId);
    if (who) await ensureEmailChannel(client, who);
    const timing = await myTiming(client);
    const channels = await myChannels(client);
    const locations = await myLocations(client);
    const prefs = storedMap(await myPreferences(client));
    const setup = notify.push ? await notify.push() : null;
    return {
      ...timing,
      smtpConfigured: notify.mailConfigured,
      push: setup?.available
        ? { available: true, publicKey: setup.publicKey }
        : { available: false, publicKey: null, reason: setup?.reason ?? 'no_subject' },
      channels,
      locations: locations.map((l) => ({ ...l, kinds: kindsFor(l.role, l.locationId, prefs) })),
      account: { aiSummary: { email: aiSummaryEmail(prefs) } },
    };
  }

  /** One of TESTS_PER_HOUR test sends, or 429. */
  async function reserveTest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const limit = await reserveInWindow(
      pools.auth,
      limiterKey('channel-test', requireScope(req).userId),
      TESTS_PER_HOUR,
      3600,
    );
    if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
  }

  app.get(
    '/api/v1/me/notification-settings',
    { schema: { response: { 200: SettingsSchema } } },
    (req) => scopedRead(pools, req, (_tx, client, scope) => settingsOf(client, scope.userId)),
  );

  app.put(
    '/api/v1/me/notification-settings',
    { schema: { body: PutSettingsBody, response: { 200: SettingsSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await updateTiming(tx, client, scope.userId, req.body, req.id);
        return { status: 200, body: await settingsOf(client, scope.userId) };
      }),
  );

  app.put(
    '/api/v1/me/notification-preferences',
    { schema: { body: PutPreferencesBody, response: { 200: SettingsSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await putPreferences(tx, client, scope.userId, req.body.items, req.id);
        return { status: 200, body: await settingsOf(client, scope.userId) };
      }),
  );

  app.post(
    '/api/v1/me/channels',
    {
      schema: {
        body: CreateChannelBody,
        response: { 201: z.object({ channel: ChannelSchema, secret: z.string() }) },
      },
    },
    (req, reply) => {
      const master = keysOf(deps).get().current;
      return scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => ({
          status: 201,
          body: await createWebhook(tx, client, master, scope.userId, req.body, req.id),
        }),
        // The secret is shown once: a replay says the channel was made, without it.
        { redact: (body) => ({ channel: (body as { channel: unknown }).channel, secret: '' }) },
      );
    },
  );

  app.delete('/api/v1/me/channels/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteChannel(tx, client, scope.userId, req.params.id, req.id);
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/me/channels/:id/test',
    { schema: { params: IdParams, response: { 200: TestResultSchema } } },
    async (req, reply) => {
      const scope = requireScope(req);
      const { channel, who } = await scopedRead(pools, req, async (_tx, client) => {
        const { rows } = await client.query<{ id: string; kind: string }>(
          `SELECT id, kind FROM public.notification_channels
            WHERE id = $1 AND user_id = kept.current_user_id()`,
          [req.params.id],
        );
        return { channel: rows[0], who: await mailIdentity(pools, client, scope.userId) };
      });
      if (!channel) throw notFound();
      await reserveTest(req, reply);
      if (channel.kind === 'email') return testEmailSend(notify, who);
      if (channel.kind === 'webpush') {
        return testPushSend(notify, pools, scope.userId, who?.locale ?? null);
      }
      return testWebhookSend(
        notify,
        pools,
        keysOf(deps).get().keyring,
        deps.env.KEPT_PUBLIC_URL,
        scope.userId,
        channel.id,
      );
    },
  );

  app.post(
    '/api/v1/me/push-subscriptions',
    { schema: { body: SubscriptionBody, response: { 201: z.object({ id: z.uuid() }) } } },
    async (req, reply) => {
      const setup = notify.push ? await notify.push() : null;
      if (!setup?.available) {
        throw new AppError('push_unavailable', 409, "Push notifications aren't available here.");
      }
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { id } = await upsertSubscription(pools, tx, client, scope.userId, req.body, req.id);
        return { status: 201, body: { id } };
      });
    },
  );

  app.delete('/api/v1/me/push-subscriptions/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteSubscription(tx, client, scope.userId, req.params.id, req.id);
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/me/push-subscriptions/:id/test',
    { schema: { params: IdParams, response: { 200: TestResultSchema } } },
    async (req, reply) => {
      const scope = requireScope(req);
      const { found, who } = await scopedRead(pools, req, async (_tx, client) => {
        const { rows } = await client.query(
          `SELECT 1 FROM public.push_subscriptions
            WHERE id = $1 AND user_id = kept.current_user_id()`,
          [req.params.id],
        );
        return { found: rows.length > 0, who: await mailIdentity(pools, client, scope.userId) };
      });
      if (!found) throw notFound();
      await reserveTest(req, reply);
      return testPushSend(notify, pools, scope.userId, who?.locale ?? null, req.params.id);
    },
  );
}
