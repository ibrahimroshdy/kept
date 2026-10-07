import { createHash } from 'node:crypto';
import { PROVIDER_KINDS, type ProviderKind } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { OidcConfig } from '../auth/oidc.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import type { Mail, Mailer } from '../mail/mailer.js';

// D180's configuration notices (step-6 plan T16, Q16, Q24): every active user is told when the
// instance's OIDC sign-in, its outgoing mail, or its default AI provider changes.
//
// - OIDC and SMTP are configured by the environment, so they can only change across a restart.
//   At boot, checkConfigNotices() hashes each configuration (OIDC: issuer, client id, name, the
//   autoprovision lists and the groups claim, the things that decide who gets in, never the client
//   secret; SMTP: host and sender, never the password) and compares it with
//   `instance_settings.oidc_config_hash` / `smtp_config_hash`. A different hash is stored, the
//   change audited (`instance.oidc_changed`, `instance.smtp_changed`, as the system) and a
//   `transparency-notice` job sent on the same transaction. Replicas booting together race on the
//   row lock: one sends. The first boot with no stored hash only records it (an upgrade to step 6
//   is not a change anyone made).
// - The instance AI provider changes through step 3's PUT /api/v1/ai/providers/instance, which
//   sends the job for its own `ai.provider_set` event when the kind changed (ai/api.ts).
// The job's data names the audit event and nothing else; what it says is read from that event
// (jobs/boss.ts's rule), and only for these three actions at instance level. Mail goes over the
// worker's current transport, so an SMTP notice travels the new way.

export const OIDC_CONFIG_HASH_KEY = 'oidc_config_hash';
export const SMTP_CONFIG_HASH_KEY = 'smtp_config_hash';

export const TRANSPARENCY_JOB = 'transparency-notice';

/** SHA-256 (hex) of a value's JSON. */
export function configHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** What the OIDC hash covers (never the client secret), and what the notice and its audit say. */
export function oidcFacts(cfg: OidcConfig | null): {
  hashed: unknown;
  facts: { name: string | null; issuer: string | null };
} {
  if (!cfg) return { hashed: { off: true }, facts: { name: null, issuer: null } };
  return {
    hashed: {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      name: cfg.name,
      domains: [...cfg.autoprovisionDomains].sort(),
      groups: [...cfg.autoprovisionGroups].sort(),
      groupsClaim: cfg.groupsClaim,
    },
    facts: { name: cfg.name, issuer: cfg.issuer },
  };
}

/** The SMTP host and sender from KEPT_SMTP_URL and KEPT_SMTP_FROM (never the password); null
 * when mail isn't configured. */
export function smtpFacts(
  smtpUrl: string | undefined,
  sender: string | undefined,
): { host: string; sender: string } | null {
  if (!smtpUrl || !sender) return null;
  let host = '';
  try {
    const u = new URL(smtpUrl);
    host = `${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return null;
  }
  return { host, sender };
}

type Send = (client: pg.ClientBase, name: string, data: object) => Promise<void>;

export type ConfigNoticeDeps = {
  pools: Pick<Pools, 'system'>;
  /** Sends a system job on the given transaction (jobs/boss.ts sendInTx). */
  send: Send;
  oidc: OidcConfig | null;
  smtp: { host: string; sender: string } | null;
};

/** One configuration's check. Returns the audit event of a change, or null. */
async function checkOne(
  deps: ConfigNoticeDeps,
  key: string,
  hash: string,
  action: string,
  facts: Record<string, unknown>,
): Promise<string | null> {
  return withSystem(deps.pools.system, async (tx, client) => {
    const inserted = await client.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO NOTHING`,
      [key, hash],
    );
    if ((inserted.rowCount ?? 0) > 0) return null; // the first boot: a baseline, not a change
    const { rows } = await client.query<{ value: unknown }>(
      'SELECT value FROM public.instance_settings WHERE key = $1 FOR UPDATE',
      [key],
    );
    if (rows[0]?.value === hash) return null;
    await client.query(
      'UPDATE public.instance_settings SET value = to_jsonb($2::text) WHERE key = $1',
      [key, hash],
    );
    const { id } = await audited(tx, {
      locationId: null,
      ownerAccountId: null,
      actor: { type: 'system', id: null },
      action,
      entity: { type: 'instance', id: null },
      before: {},
      after: facts,
    });
    await deps.send(client, TRANSPARENCY_JOB, { auditEventId: id });
    return id;
  });
}

/** The boot check (plan Q16, Q24). Returns the audit events of the changes it found. */
export async function checkConfigNotices(deps: ConfigNoticeDeps): Promise<string[]> {
  const out: string[] = [];
  const oidc = oidcFacts(deps.oidc);
  const o = await checkOne(
    deps,
    OIDC_CONFIG_HASH_KEY,
    configHash(oidc.hashed),
    'instance.oidc_changed',
    oidc.facts,
  );
  if (o) out.push(o);
  if (deps.smtp) {
    const s = await checkOne(
      deps,
      SMTP_CONFIG_HASH_KEY,
      configHash(deps.smtp),
      'instance.smtp_changed',
      deps.smtp,
    );
    if (s) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Diff = Record<string, { after?: unknown } | undefined>;

/** The notice an instance-level audit event calls for (without its recipient), or null. */
/** A notice's mail, before its recipient. */
export type Notice =
  | { kind: 'oidc-changed'; name: string | null }
  | { kind: 'smtp-changed'; sender: string }
  | { kind: 'ai-provider-changed'; provider: ProviderKind };

export function noticeOf(action: string, diff: Diff): Notice | null {
  const after = (field: string) => diff[field]?.after;
  if (action === 'instance.oidc_changed') {
    const name = after('name');
    return { kind: 'oidc-changed', name: typeof name === 'string' ? name : null };
  }
  if (action === 'instance.smtp_changed') {
    const sender = after('sender');
    return typeof sender === 'string' ? { kind: 'smtp-changed', sender } : null;
  }
  if (action === 'ai.provider_set') {
    // Only when the kind changed: a new key or model for the same provider is no notice.
    const kind = after('kind');
    return typeof kind === 'string' && (PROVIDER_KINDS as readonly string[]).includes(kind)
      ? { kind: 'ai-provider-changed', provider: kind as ProviderKind }
      : null;
  }
  return null;
}

export type NoticeDeps = {
  pools: Pick<Pools, 'system' | 'auth'>;
  mailer: Mailer;
  log?: { error: (obj: object, msg: string) => void } | undefined;
};

/** Runs one `transparency-notice` job. Returns how many people were mailed. */
export async function runTransparencyNotice(deps: NoticeDeps, raw: unknown): Promise<number> {
  const auditEventId = (raw as { auditEventId?: unknown } | null)?.auditEventId;
  if (typeof auditEventId !== 'string' || !UUID.test(auditEventId)) return 0;
  const event = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<{ action: string; diff: Diff }>(
      `SELECT action, diff FROM public.audit_events
        WHERE id = $1 AND location_id IS NULL AND owner_account_id IS NULL`,
      [auditEventId],
    );
    return rows[0] ?? null;
  });
  const notice = event ? noticeOf(event.action, event.diff) : null;
  if (!notice) return 0;
  // Every active account: not banned, and with a mailbox (managed accounts have none, D47).
  const { rows } = await deps.pools.auth.query<{ email: string }>(
    'SELECT email FROM auth."user" WHERE coalesce(banned, false) = false ORDER BY id',
  );
  let sent = 0;
  for (const { email } of rows) {
    if (isUndeliverableEmail(email)) continue;
    // One failed address never stops the rest; the job isn't retried (it would mail twice).
    await deps.mailer
      .send({ ...notice, to: email } as Mail)
      .then(() => {
        sent += 1;
      })
      .catch((err: unknown) => deps.log?.error({ err }, 'transparency notice not sent'));
  }
  return sent;
}

export function transparencyJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: TRANSPARENCY_JOB,
      kind: 'system',
      policy: JOB_POLICIES[TRANSPARENCY_JOB],
      handler: async (data) => {
        await runTransparencyNotice(
          { pools: deps.pools, mailer: deps.mailer, log: deps.log },
          data,
        );
      },
    }),
  ];
}
