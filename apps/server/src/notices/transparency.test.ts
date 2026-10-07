import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx, seedUser } from '../../test/tenancy.js';
import type { OidcConfig } from '../auth/oidc.js';
import type { Mail } from '../mail/mailer.js';
import {
  checkConfigNotices,
  configHash,
  noticeOf,
  oidcFacts,
  runTransparencyNotice,
  smtpFacts,
  TRANSPARENCY_JOB,
} from './transparency.js';

// D180's configuration notices (step-6 plan T16, Q16, Q24): a changed OIDC or SMTP configuration
// is found at boot by its hash, audited as the system, and told to every active user once; the
// first boot only records the hash; the hash never covers a secret.

const db: TestDb = await testDb();
const sent: { name: string; data: { auditEventId: string } }[] = [];
const deps = (
  oidc: OidcConfig | null,
  smtp = smtpFacts('smtp://mail.example.org:587', 'Kept <kept@example.org>'),
) => ({
  pools: db.pools,
  send: async (_c: unknown, name: string, data: object) => {
    sent.push({ name, data: data as { auditEventId: string } });
  },
  oidc,
  smtp,
});

const sso = (name: string): OidcConfig => ({
  issuer: 'https://sso.example.net/kept',
  clientId: 'kept',
  clientSecret: 'never-hashed',
  name,
  autoprovisionDomains: [],
  autoprovisionGroups: ['kept-family'],
  groupsClaim: 'groups',
  scopes: ['openid', 'email', 'profile'],
});

beforeEach(async () => {
  await db.reset();
  sent.length = 0;
});

describe('the boot check', () => {
  it('records a baseline on first boot, then audits and notifies each change once', async () => {
    expect(await checkConfigNotices(deps(sso('Home SSO')))).toEqual([]);
    expect(sent).toEqual([]);
    // Unchanged: nothing.
    expect(await checkConfigNotices(deps(sso('Home SSO')))).toEqual([]);
    // Renamed, and mail moved: one event each, a job each.
    const changed = await checkConfigNotices(
      deps(sso('Family SSO'), smtpFacts('smtps://smtp.example.net', 'kept@example.net')),
    );
    expect(changed).toHaveLength(2);
    expect(sent.map((s) => s.name)).toEqual([TRANSPARENCY_JOB, TRANSPARENCY_JOB]);
    const events = await ownerTx(
      db,
      async (c) =>
        (
          await c.query<{ action: string; actor_type: string; diff: Record<string, unknown> }>(
            `SELECT action, actor_type, diff FROM public.audit_events WHERE id = ANY($1) ORDER BY action`,
            [changed],
          )
        ).rows,
    );
    expect(events.map((e) => [e.action, e.actor_type])).toEqual([
      ['instance.oidc_changed', 'system'],
      ['instance.smtp_changed', 'system'],
    ]);
    expect(JSON.stringify(events)).not.toContain('never-hashed');
    // Booting again with the same configuration says nothing more.
    expect(
      await checkConfigNotices(
        deps(sso('Family SSO'), smtpFacts('smtps://smtp.example.net', 'kept@example.net')),
      ),
    ).toEqual([]);
  });

  it('hashes what decides who gets in, never the client secret or the mail password', () => {
    const a = sso('Home SSO');
    expect(configHash(oidcFacts(a).hashed)).toBe(
      configHash(oidcFacts({ ...a, clientSecret: 'another' }).hashed),
    );
    expect(configHash(oidcFacts(a).hashed)).not.toBe(
      configHash(oidcFacts({ ...a, autoprovisionDomains: ['example.org'] }).hashed),
    );
    expect(smtpFacts('smtp://user:pass@mail.example.org:587', 'kept@example.org')).toEqual({
      host: 'mail.example.org:587',
      sender: 'kept@example.org',
    });
  });
});

describe('the notice job', () => {
  it('mails every active user with a mailbox, read from the audit event', async () => {
    const louis = await seedUser(db, 'louis');
    const banned = await seedUser(db, 'banned');
    await ownerTx(db, (c) =>
      c.query('UPDATE auth."user" SET banned = true WHERE id = $1', [banned]),
    );
    await ownerTx(db, (c) =>
      c.query(`UPDATE auth."user" SET email = 'peter@managed.invalid' WHERE id = $1`, [louis]),
    );
    const talia = await seedUser(db, 'talia');
    await checkConfigNotices(deps(sso('Home SSO')));
    const [id] = await checkConfigNotices(deps(null));
    const mails: Mail[] = [];
    const count = await runTransparencyNotice(
      { pools: db.pools, mailer: { send: async (m) => void mails.push(m) } },
      { auditEventId: id },
    );
    const { rows } = await db.pools.auth.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1',
      [talia],
    );
    expect(count).toBe(1);
    expect(mails).toEqual([{ kind: 'oidc-changed', name: null, to: rows[0]?.email }]);
    // A made-up id, or an event that isn't one of these, mails nobody.
    expect(
      await runTransparencyNotice(
        { pools: db.pools, mailer: { send: async (m) => void mails.push(m) } },
        { auditEventId: '0192f0c3-7c55-7000-8000-000000000001' },
      ),
    ).toBe(0);
  });

  it('tells of a new instance AI provider only when its kind changed', () => {
    expect(noticeOf('ai.provider_set', { kind: { after: 'groq' } })).toEqual({
      kind: 'ai-provider-changed',
      provider: 'groq',
    });
    expect(noticeOf('ai.provider_set', { api_key: { after: 'x' } })).toBeNull();
    expect(noticeOf('ai.provider_set', { kind: { after: 'not-a-provider' } })).toBeNull();
    expect(noticeOf('thing.move', {})).toBeNull();
  });
});
