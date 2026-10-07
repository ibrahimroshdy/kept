import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 6's fixture rows for the leak test (test/leak.test.ts, fillTenant()), after steps 2–5
// (test/leak-inventory.ts, test/leak-capture.ts, test/leak-household.ts, test/leak-vehicles.ts):
// the token, assistant, embedding and webhook tables, for each tenant. Written as kept_owner
// inside fillTenant()'s transaction.

const lookup = () =>
  randomBytes(12)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8);

/** Fills `t`'s tables. The rows of steps 2–5 are already there. */
export async function fillAssistant(c: pg.ClientBase, t: Tenant, label: string): Promise<void> {
  const one = async (sql: string, values: unknown[]) =>
    (await c.query<{ id: string }>(sql, values)).rows[0]?.id as string;

  // Tokens (T4): a personal token limited to the tenant's location, an OAuth grant, and a rate
  // window. Made with a second factor, so the require_2fa tenant's location takes them too.
  const personal = await one(
    `INSERT INTO public.api_tokens (user_id, kind, name, lookup, hash, scope, created_with_mfa)
     VALUES ($1, 'personal', $2, $3, $4, 'read', true) RETURNING id`,
    [
      t.userId,
      `${label} token`,
      lookup(),
      createHash('sha256').update(`${label} secret`).digest('hex'),
    ],
  );
  const oauth = await one(
    `INSERT INTO public.api_tokens (user_id, kind, name, oauth_client_id, scope, created_with_mfa)
     VALUES ($1, 'oauth', $2, $3, 'write', true) RETURNING id`,
    [t.userId, `${label} connector`, `https://${label}.example.test/client.json`],
  );
  for (const token of [personal, oauth]) {
    await c.query('INSERT INTO public.token_locations (token_id, location_id) VALUES ($1, $2)', [
      token,
      t.locationId,
    ]);
  }
  // A change the personal token made there: the name kept.token_actor_names (0105) gives.
  await c.query(
    `INSERT INTO public.audit_events
       (location_id, owner_account_id, actor_type, actor_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'token', $3, 'update', 'location', $1)`,
    [t.locationId, t.accountId, personal],
  );
  await c.query(
    `INSERT INTO public.token_rate_windows (token_id, minute, kind, count)
     VALUES ($1, date_trunc('minute', now()), 'read', 3)`,
    [personal],
  );

  // The assistant (T5): a thread with a turn, one message of each role, a tool result from the
  // tenant's location, and an open proposal there.
  const thread = await one(
    `INSERT INTO public.assistant_threads (user_id, title, locale, context)
     VALUES ($1, $2, 'en', jsonb_build_object('kind', 'location', 'locationId', $3::text))
     RETURNING id`,
    [t.userId, `${label} thread`, t.locationId],
  );
  const turn = await one(
    `INSERT INTO public.assistant_turns (thread_id, user_id, status, location_ids)
     VALUES ($1, $2, 'done', ARRAY[$3::uuid]) RETURNING id`,
    [thread, t.userId, t.locationId],
  );
  const text = (s: string) => JSON.stringify([{ type: 'text', text: s }]);
  await c.query(
    `INSERT INTO public.assistant_messages (thread_id, turn_id, user_id, role, step, parts)
     VALUES ($1, $2, $3, 'user', 0, $4)`,
    [thread, turn, t.userId, text(`Where is the ${label} thing?`)],
  );
  const call = JSON.stringify([
    { type: 'tool_call', callId: 'c1', tool: 'where_is', input: { q: `${label} thing` } },
  ]);
  await c.query(
    `INSERT INTO public.assistant_messages (thread_id, turn_id, user_id, role, step, parts,
                                            cited_location_ids)
     VALUES ($1, $2, $3, 'assistant', 1, $4, ARRAY[$5::uuid])`,
    [thread, turn, t.userId, call, t.locationId],
  );
  const output = { place: `${label} room` };
  const toolMessage = await one(
    `INSERT INTO public.assistant_messages (thread_id, turn_id, user_id, role, step, parts)
     VALUES ($1, $2, $3, 'tool', 1, $4) RETURNING id`,
    [
      thread,
      turn,
      t.userId,
      JSON.stringify([
        {
          type: 'tool_result',
          callId: 'c1',
          tool: 'where_is',
          locationIds: [t.locationId],
          output,
        },
      ]),
    ],
  );
  await c.query(
    `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id, tool,
                                                output)
     VALUES ($1, $2, $3, 'c1', 'where_is', $4)`,
    [toolMessage, t.userId, t.locationId, JSON.stringify(output)],
  );
  await c.query(
    `INSERT INTO public.assistant_proposals (user_id, thread_id, turn_id, location_id, batch_id,
                                             tool, args, args_hash, expires_at)
     VALUES ($1, $2, $3, $4, uuidv7(), 'mark_seen', '{"thing_id":"x"}', $5,
             now() + interval '10 minutes')`,
    [t.userId, thread, turn, t.locationId, 'b'.repeat(64)],
  );

  // Embeddings (T6): a 3-dimension vector of the tenant's thing, and the location's index state.
  await c.query(
    `INSERT INTO public.thing_embeddings (thing_id, location_id, model_key, dims, content_hash,
                                          embedding)
     SELECT x.id, $1, 'provider:openai:probe', 3, $2, '[1,0,0]' FROM public.things x
      WHERE x.location_id = $1 AND x.name = $3`,
    [t.locationId, 'd'.repeat(64), `${label} thing`],
  );
  await c.query(
    `INSERT INTO public.embedding_state (location_id, model_key, source, pending, last_run_at)
     VALUES ($1, 'provider:openai:probe', 'provider', 1, now())`,
    [t.locationId],
  );

  // Webhooks (T7): a hook with a (fake) sealed secret, and one delivery of an event to it.
  const hook = await one(
    `INSERT INTO public.webhooks (location_id, url, secret_ciphertext, key_version, events,
                                  created_by)
     VALUES ($1, $2, '{"v": 1, "c": "x"}', 1, ARRAY['thing.created', 'thing.moved'], $3)
     RETURNING id`,
    [t.locationId, `https://${label}.example.test/hook`, t.userId],
  );
  await c.query(
    `INSERT INTO public.webhook_deliveries (location_id, webhook_id, event_id, event, status,
                                            attempts, http_status)
     VALUES ($1, $2, $3, 'thing.created', 'delivered', 1, 204)`,
    [t.locationId, hook, `evt_${label}0123456789`],
  );
}
