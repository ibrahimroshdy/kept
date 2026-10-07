import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import {
  generateSetupCode,
  hashSetupCode,
  SETUP_CODE_KEY,
  SETUP_LOCK,
} from '../setup/setup-code.js';
import { type BenchInfo, formatBench } from './bench.js';
import { type Cast, HOUSEHOLDS_CAST, type PersonKey, SEED_PASSWORD } from './cast.js';
import { Client, cookieOf, expectStatus, SeedError } from './client.js';
import { stockRecords } from './records.js';
import { type StockSummary, stockHouseholds } from './stock.js';

export { SeedError };

// `kept admin seed --scenario households` (task 26; D152, D185). Everything goes through the
// service layer: the real HTTP routes of an in-process app (app.inject), so every policy, audit
// event, hook and invariant a person would meet applies. Only reads that decide whether a step
// is already done look past it, and even those go through the API where one exists.
//
// Idempotent: each step looks first and does only what is missing, so a second run changes
// nothing. It never resets a password: an account whose password was changed since is reported,
// not overwritten.

export type SeedContext = {
  /** A Kept app built for the seed (seed/index.ts): Better Auth mounted, sign-up open. */
  app: KeptApp;
  pools: Pick<Pools, 'system' | 'app'>;
  publicUrl: string;
  /** Whether the app serves files: without, photos and receipts are left out (and noted). */
  hasFiles: boolean;
  /** "Now", for membership end dates and meter readings. */
  now?: Date;
};

export type SeededAccount = {
  displayName: string;
  /** What to type at sign-in: the email, or a managed account's username. */
  login: string;
  password: string;
  instanceAdmin: boolean;
  /** "Home: owner", "بيت العائلة: admin until 2026-10-26", … */
  roles: string[];
  managed: boolean;
};

export type SeedReport = {
  scenario: 'households' | 'bench';
  /** How many changes this run made; 0 on a run after a complete one. */
  created: number;
  households: { name: string; id: string }[];
  accounts: SeededAccount[];
  /** What each location holds after the run (task 23). */
  inventory: StockSummary[];
  /** The bench scenario's fixture, for the RLS benchmark (task 24). */
  bench?: BenchInfo;
  /** Things the seed could not do as planned, and why (e.g. an instance admin already exists). */
  notes: string[];
};

type LocationRow = {
  id: string;
  name: string;
  role: string;
  rowVersion: number;
  languages: string[];
};
type MemberRow = {
  userId: string;
  displayName: string;
  username: string | null;
  role: string;
  expiresAt: string | null;
  managed: boolean;
};

/** What seedCast() leaves for the scenario's next steps. */
export type CastSession<K extends string> = {
  client: Client;
  /** Each person's session cookie. */
  cookieOf: (key: K) => string;
  /** Whether the cast's instance admin is one (false when this Kept was set up before). */
  adminIsInstanceAdmin: boolean;
  now: Date;
};

export function emptyReport(scenario: SeedReport['scenario']): SeedReport {
  return { scenario, created: 0, households: [], accounts: [], inventory: [], notes: [] };
}

/**
 * The cast's people and locations (task 26): first-run setup, sign-ups, locations, invites
 * accepted, managed accounts. Adds to `report` and returns the sessions for the next steps.
 */
export async function seedCast<K extends string>(
  ctx: SeedContext,
  cast: Cast<K>,
  report: SeedReport,
): Promise<CastSession<K>> {
  const client = new Client(ctx.app, ctx.publicUrl);
  const now = ctx.now ?? new Date();
  const people = cast.people;
  const instanceAdmin = cast.instanceAdmin;
  const cookies = new Map<K, string>();
  const personHeaders = (key: K) => ({
    'accept-language': people[key].locale,
    'x-kept-timezone': people[key].timezone,
  });

  const signIn = async (key: K): Promise<string | null> => {
    const res = await client.call('POST', '/api/v1/auth/sign-in/email', {
      body: { email: people[key].email, password: SEED_PASSWORD },
      headers: personHeaders(key),
    });
    return res.statusCode === 200 ? cookieOf(res) : null;
  };

  // 1. The instance admin: through first-run setup while it is pending. The seed issues a fresh
  //    setup code for itself (as `kept admin setup-code` would), under the setup lock.
  const setup = expectStatus(await client.call('GET', '/api/v1/setup'), [200], 'setup status');
  let adminKey: K | null = null;
  if (setup.needed === true) {
    const code = generateSetupCode();
    await withSystem(ctx.pools.system, async (_tx, c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
      await c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [SETUP_CODE_KEY, JSON.stringify(hashSetupCode(code))],
      );
    });
    const person = people[instanceAdmin];
    const res = await client.call('POST', '/api/v1/setup', {
      body: { code, email: person.email, password: SEED_PASSWORD, displayName: person.displayName },
      headers: personHeaders(instanceAdmin),
    });
    expectStatus(res, [201], 'first-run setup');
    report.created += 1;
    adminKey = instanceAdmin;
  }

  // 2. Everyone else signs up (sign-up is open in the seed's app) unless they can sign in.
  for (const key of Object.keys(people) as K[]) {
    let cookie = await signIn(key);
    if (!cookie) {
      const person = people[key];
      expectStatus(
        await client.call('POST', '/api/v1/auth/sign-up', {
          body: { email: person.email, password: SEED_PASSWORD, displayName: person.displayName },
          headers: personHeaders(key),
        }),
        [202],
        `sign-up of ${person.email}`,
      );
      cookie = await signIn(key);
      if (!cookie) {
        throw new SeedError(
          `${person.email} exists with another password; run \`kept admin reset-password ${person.email}\` or use a fresh database`,
        );
      }
      report.created += 1;
    }
    cookies.set(key, cookie);
  }
  const as = (key: K) => cookies.get(key) as string;

  const me = expectStatus(
    await client.call('GET', '/api/v1/me', { cookie: as(instanceAdmin) }),
    [200],
    'me',
  );
  const adminIsInstanceAdmin =
    adminKey !== null ||
    (me.user as { instanceAdmin?: boolean } | undefined)?.instanceAdmin === true;
  if (!adminIsInstanceAdmin) {
    report.notes.push(
      `${people[instanceAdmin].email} is not an instance admin: this Kept was set up before the seed ran.`,
    );
  }

  const roles = new Map<string, string[]>();
  const addRole = (login: string, text: string) =>
    roles.set(login, [...(roles.get(login) ?? []), text]);
  const day = (iso: string | null) => (iso ? ` until ${iso.slice(0, 10)}` : '');

  for (const household of cast.households) {
    const owner = as(household.owner);

    // 3. The location, found by name among the owner's own.
    const listed = expectStatus(
      await client.call('GET', '/api/v1/locations?limit=200', { cookie: owner }),
      [200],
      'locations',
    ) as { locations?: LocationRow[] };
    let location = (listed.locations ?? []).find(
      (l) => l.name === household.name && l.role === 'owner',
    );
    if (!location) {
      location = expectStatus(
        await client.call('POST', '/api/v1/locations', {
          cookie: owner,
          body: {
            name: household.name,
            kind: household.kind,
            timezone: household.timezone,
            currency: household.currency,
          },
        }),
        [201],
        `create ${household.name}`,
      ) as unknown as LocationRow;
      report.created += 1;
    }
    const want = household.languages;
    if (JSON.stringify(location.languages ?? []) !== JSON.stringify(want)) {
      expectStatus(
        await client.call('PATCH', `/api/v1/locations/${location.id}`, {
          cookie: owner,
          body: { languages: want },
          headers: { 'if-match': String(location.rowVersion) },
        }),
        [200],
        `languages of ${household.name}`,
      );
      report.created += 1;
    }
    report.households.push({ name: household.name, id: location.id });
    addRole(people[household.owner].email, `${household.name}: owner`);

    const members = async () =>
      (
        expectStatus(
          await client.call('GET', `/api/v1/locations/${location.id}/members?limit=200`, {
            cookie: owner,
          }),
          [200],
          `members of ${household.name}`,
        ) as { members: MemberRow[] }
      ).members;
    let current = await members();

    // 4. Members join through a link invite from the owner, accepted by the person.
    for (const m of household.members) {
      const person = people[m.who];
      let row = current.find((r) => r.displayName === person.displayName && !r.managed);
      if (!row) {
        const until = m.endsInDays
          ? new Date(now.getTime() + m.endsInDays * 86_400_000).toISOString()
          : null;
        const invite = expectStatus(
          await client.call('POST', `/api/v1/locations/${location.id}/invites`, {
            cookie: owner,
            body: { role: m.role, ...(until ? { membershipExpiresAt: until } : {}) },
          }),
          [201],
          `invite ${person.email} to ${household.name}`,
        );
        const token = new URL(String(invite.url)).hash.slice(1);
        expectStatus(
          await client.call('POST', `/api/v1/invites/${encodeURIComponent(token)}/accept`, {
            cookie: as(m.who),
            body: {},
          }),
          [200],
          `${person.email} accepts ${household.name}`,
        );
        report.created += 1;
        current = await members();
        row = current.find((r) => r.displayName === person.displayName && !r.managed);
      }
      addRole(
        person.email,
        `${household.name}: ${row?.role ?? m.role}${day(row?.expiresAt ?? null)}`,
      );
    }

    // 5. Managed accounts, made by an owner or admin; the person's password is set with the
    //    one-time code, the way a parent would hand it over (D164).
    for (const m of household.managed) {
      const managed = cast.managed[m.who];
      if (!managed) throw new SeedError(`no managed account ${m.who} in the cast`);
      let row = current.find((r) => r.managed && r.username === managed.username);
      if (!row) {
        const made = expectStatus(
          await client.call('POST', `/api/v1/locations/${location.id}/managed-accounts`, {
            cookie: as(m.createdBy),
            body: { displayName: managed.displayName, username: managed.username, role: m.role },
          }),
          [201],
          `managed account ${managed.username}`,
        );
        expectStatus(
          await client.call('POST', '/api/v1/auth/reset-code', {
            body: { username: managed.username, code: made.code, newPassword: SEED_PASSWORD },
          }),
          [204],
          `password of ${managed.username}`,
        );
        report.created += 1;
        current = await members();
        row = current.find((r) => r.managed && r.username === managed.username);
      }
      addRole(
        managed.username,
        `${household.name}: ${row?.role ?? m.role} · managed, made by ${people[m.createdBy].displayName}`,
      );
    }
  }

  for (const [key, person] of Object.entries(people) as [K, (typeof people)[K]][]) {
    report.accounts.push({
      displayName: person.displayName,
      login: person.email,
      password: SEED_PASSWORD,
      instanceAdmin: key === instanceAdmin && adminIsInstanceAdmin,
      roles: roles.get(person.email) ?? [],
      managed: false,
    });
  }
  for (const managed of Object.values(cast.managed)) {
    report.accounts.push({
      displayName: managed.displayName,
      login: managed.username,
      password: SEED_PASSWORD,
      instanceAdmin: false,
      roles: roles.get(managed.username) ?? [],
      managed: true,
    });
  }
  return { client, cookieOf: as, adminIsInstanceAdmin, now };
}

/** `kept admin seed --scenario households`: the cast, then what their households hold. */
export async function seedHouseholds(ctx: SeedContext): Promise<SeedReport> {
  const report = emptyReport('households');
  const session = await seedCast<PersonKey>(ctx, HOUSEHOLDS_CAST, report);
  // What the households hold (task 23): places, things, purchases, readings, photos, views.
  if (!ctx.hasFiles) report.notes.push('photos and receipts skipped: the app has no file storage.');
  report.inventory = await stockHouseholds({
    client: session.client,
    pools: ctx.pools,
    cookieOf: session.cookieOf,
    locations: new Map(report.households.map((h) => [h.name, h.id])),
    hasFiles: ctx.hasFiles,
    instanceAdmin: session.adminIsInstanceAdmin ? HOUSEHOLDS_CAST.instanceAdmin : null,
    now: session.now,
    made: () => {
      report.created += 1;
    },
    note: (text) => report.notes.push(text),
  });
  // What they did with them (step 4's records, step 5's vehicles): seed/records.ts.
  await stockRecords({
    client: session.client,
    pools: ctx.pools,
    cookieOf: session.cookieOf,
    locations: new Map(report.households.map((h) => [h.name, h.id])),
    hasFiles: ctx.hasFiles,
    now: session.now,
    made: () => {
      report.created += 1;
    },
    note: (text) => report.notes.push(text),
  });

  return report;
}

/** The report as the CLI prints it. */
export function formatSeedReport(report: SeedReport, publicUrl: string): string {
  const lines = [
    `Kept seed: ${report.scenario} — ${
      report.created > 0 ? `made ${report.created} changes` : 'already seeded, nothing to do'
    }.`,
    '',
    `Sign in at ${new URL('/signin', publicUrl).toString()}. Every password is: ${SEED_PASSWORD}`,
    '',
  ];
  const width = Math.max(...report.accounts.map((a) => a.login.length));
  const nameWidth = Math.max(6, ...report.accounts.map((a) => a.displayName.length));
  for (const a of report.accounts) {
    const what = [a.instanceAdmin ? 'instance admin' : null, ...a.roles].filter(Boolean);
    const login = a.managed ? `${a.login} (username)` : a.login;
    lines.push(
      `  ${a.displayName.padEnd(nameWidth)} ${login.padEnd(width + 11)} ${what.join(' · ')}`,
    );
  }
  lines.push('');
  for (const h of report.households) lines.push(`  ${h.name}: ${h.id}`);
  if (report.inventory.length > 0 && !report.bench) lines.push('');
  for (const s of report.bench ? [] : report.inventory) {
    lines.push(`  ${s.location}: ${s.places} places, ${s.things} things`);
  }
  if (report.bench) lines.push(...formatBench(report.bench));
  for (const note of report.notes) lines.push('', `Note: ${note}`);
  return `${lines.join('\n')}\n`;
}
