/**
 * An in-memory stand-in for the Kept server, shared by component tests and the demo mode
 * (`?demo=1` in dev and demo builds). It answers the paths in ../paths.ts from a mutable state,
 * records every call, and lets a test replace one route (to force an error or a pending state).
 *
 * Never imported by production code paths: main.tsx loads it only behind a compile-time flag
 * that is false in a production build, so it is not in the bundle.
 */
import { assistantMockRoutes } from '../assistant/mock';
import { captureMockRoutes } from '../capture/mock';
import { AUDIT_EVENT_HEADER } from '../client';
import { connectionsMockRoutes } from '../connections/mock';
import { householdMockRoutes } from '../household/mock';
import { inventoryMockRoutes } from '../inventory/mock';
import { opsMockRoutes } from '../ops/mock';
import { ops } from '../ops/mock/state';
import { paths } from '../paths';
import { portabilityMockRoutes } from '../portability/mock';
import {
  type AcceptInviteBody,
  type AdminSettings,
  type AdminSettingsBody,
  type CreateInviteBody,
  type CreateLocationBody,
  type CreateManagedBody,
  type EmailChangeBody,
  HOSTNAME,
  type LocationDetail,
  MAX_FORMER_HOSTNAMES,
  type SetModulesBody,
  type SetupBody,
  type UpdateMemberBody,
} from '../types';
import { vehicleMockRoutes } from '../vehicles/mock';
import { MOCK_ACCOUNTS, type MockState, uuid } from './fixtures';
import { err, type Handler, MockReply, type MockRequest, PASS, reply, sessionGate } from './kit';

export { MockReply, type MockRequest };

const authErr = (status: number, code: string, message: string) => reply(status, { code, message });

/** A route pattern built from a paths.ts function, e.g. paths.location(':id'). */
function pattern(template: string): RegExp {
  const src = template
    .split('/')
    .map((part) => (part.startsWith('%3A') ? `(?<${part.slice(3)}>[^/]+)` : part))
    .join('/');
  return new RegExp(`^${src}$`);
}

export type MockApi = {
  fetch: typeof fetch;
  state: MockState;
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  /** Replace one route. `handler` may return a never-settling promise to hold a loading state. */
  on: (method: string, template: string, handler: Handler) => void;
  /** Hold every matching request pending forever (loading-state tests). */
  hang: (method: string, template: string) => void;
  /** The last call to a path, for assertions. */
  lastCall: (
    method: string,
    path: string,
  ) => { body: unknown; headers: Record<string, string> } | undefined;
};

export function createMockApi(state: MockState): MockApi {
  const routes: { method: string; re: RegExp; handler: Handler }[] = [];
  const calls: MockApi['calls'] = [];
  const add = (method: string, template: string, handler: Handler) => {
    routes.unshift({ method, re: pattern(template), handler });
  };

  const requireSession = (): MockReply | null => sessionGate(state);
  const requireAdmin = (): MockReply | null =>
    requireSession() ??
    (state.me.user.instanceAdmin ? null : err(403, 'forbidden', "You don't have permission."));
  const loc = (id: string): LocationDetail | undefined => state.locations.find((l) => l.id === id);

  // ----- meta, setup, auth ---------------------------------------------------------------------
  add('GET', paths.version, () => state.version);
  add('GET', paths.setup, () => ({ needed: state.setupNeeded }));
  add('POST', paths.setup, ({ body }) => {
    const b = body as SetupBody;
    if (!state.setupNeeded) return err(409, 'conflict', 'Kept is already set up.');
    if (b.code.replace(/-/g, '').toUpperCase() !== state.setupCode)
      return err(400, 'setup_code_invalid', 'The setup code is not valid.');
    state.setupNeeded = false;
    state.me.user.displayName = b.displayName;
    state.me.user.email = b.email;
    return { userId: state.me.user.id };
  });
  const signIn = ({ body }: MockRequest) => {
    const b = body as { email?: string; username?: string; password: string };
    if (b.password !== state.password)
      return authErr(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password');
    if (state.me.user.twoFactorEnabled) {
      state.twoFactorCookie = true;
      return { twoFactorRedirect: true, twoFactorMethods: ['totp'] };
    }
    state.signedIn = true;
    return { user: { id: state.me.user.id, email: b.email ?? '', name: 'x' } };
  };
  add('POST', paths.auth.signInEmail, signIn);
  add('POST', paths.auth.signInUsername, signIn);
  add('POST', paths.auth.signInMagicLink, () => ({ status: true }));
  add('POST', paths.auth.requestPasswordReset, () => ({ status: true }));
  add('POST', paths.auth.resetPassword, ({ body }) => {
    const b = body as { token: string; newPassword: string };
    if (b.token !== state.magicToken) return authErr(400, 'INVALID_TOKEN', 'Invalid token');
    // Like Better Auth: the password changes and every session is signed out.
    state.password = b.newPassword;
    state.signedIn = false;
    return { status: true };
  });
  add('POST', paths.auth.resetCode, ({ body }) => {
    const b = body as { code: string; newPassword: string };
    if (b.code !== 'K7Q2M9TX') return err(400, 'validation', 'The code is not valid.');
    state.password = b.newPassword;
    state.me.user.twoFactorEnabled = false;
    return reply(204);
  });
  add('POST', paths.auth.magicLinkVerify, ({ body }) => {
    if ((body as { token: string }).token !== state.magicToken)
      return authErr(400, 'INVALID_TOKEN', 'Invalid token');
    state.signedIn = true;
    state.mfaPending = state.me.user.twoFactorEnabled;
    return { mfaRequired: state.mfaPending };
  });
  // Email change (D176): the link to the old address answers verify_new, the new one's done.
  add('POST', paths.auth.emailChangeConfirm, ({ body }) => {
    const token = (body as { token: string }).token;
    const pending = state.emailChangeTokens[token];
    if (!pending) return err(400, 'token_invalid', 'This link is not valid.');
    delete state.emailChangeTokens[token];
    if (pending.stage === 'old') return { stage: 'verify_new' };
    state.me.user.email = pending.newEmail;
    return { stage: 'done' };
  });
  add('POST', paths.auth.signOut, () => {
    state.signedIn = false;
    return { success: true };
  });
  add('POST', paths.auth.twoFactorVerifyTotp, ({ body }) => {
    if ((body as { code: string }).code !== state.totpCode)
      return authErr(401, 'INVALID_CODE', 'Invalid code');
    if (state.enrolling) {
      state.enrolling = false;
      state.me.user.twoFactorEnabled = true;
    }
    state.signedIn = true;
    state.mfaPending = false;
    state.twoFactorCookie = false;
    state.me.mfa = true;
    return { token: 't' };
  });
  add('POST', paths.auth.twoFactorVerifyBackupCode, ({ body }) => {
    if (!state.backupCodes.includes((body as { code: string }).code))
      return authErr(401, 'INVALID_BACKUP_CODE', 'Invalid backup code');
    state.signedIn = true;
    state.mfaPending = false;
    state.me.mfa = true;
    return { token: 't' };
  });
  add('POST', paths.auth.twoFactorEnable, ({ body }) => {
    if ((body as { password: string }).password !== state.password)
      return authErr(400, 'INVALID_PASSWORD', 'Invalid password');
    state.enrolling = true;
    return {
      totpURI: `otpauth://totp/Kept:${state.me.user.email}?secret=JBSWY3DPEHPK3PXP&issuer=Kept`,
      backupCodes: state.backupCodes,
    };
  });
  add('GET', paths.auth.passkeyAuthenticateOptions, () =>
    authErr(400, 'PASSKEY_NOT_FOUND', 'No passkey'),
  );

  // ----- me --------------------------------------------------------------------------------------
  add('GET', paths.me, () => requireSession() ?? state.me);
  add('PATCH', paths.me, ({ body }) => {
    const gate = requireSession();
    if (gate) return gate;
    const on = (body as { suggestLocation?: unknown }).suggestLocation;
    if (typeof on !== 'boolean') return err(400, 'validation', 'The request is not valid.');
    state.me.profile = { ...state.me.profile, suggestLocation: on };
    return { suggestLocation: on };
  });
  add('GET', paths.mySessions, () => requireSession() ?? { sessions: state.sessions });
  add('POST', paths.myEmailChange, ({ body }) => {
    const gate = requireSession();
    if (gate) return gate;
    const b = body as EmailChangeBody;
    const from = state.me.user.email;
    if (state.me.user.managed || !from)
      return err(
        403,
        'forbidden',
        'This account signs in with a username and has no email address.',
      );
    if (b.newEmail.trim().toLowerCase() === from.toLowerCase())
      return err(400, 'validation', 'That is already your email address.');
    // Like the server: the password, or (for an account with none) a sign-in in the last 10 min.
    if (!state.freshSignIn) {
      if (b.password === undefined) return err(403, 'reauth_required', 'Enter your password.');
      if (b.password !== state.password)
        return err(403, 'reauth_required', 'That password is not right.');
    }
    return reply(202, { stage: 'confirm_old' });
  });
  add('DELETE', paths.mySession(':id'), ({ params }) => {
    state.sessions = state.sessions.filter((s) => s.id !== params.id);
    return reply(204);
  });

  // ----- locations -------------------------------------------------------------------------------
  add('GET', paths.locations, () => requireSession() ?? { locations: state.locations });
  add('POST', paths.locations, ({ body }) => {
    const b = body as CreateLocationBody;
    const created: LocationDetail = {
      id: uuid(),
      name: b.name,
      kind: b.kind,
      ownerAccountId: MOCK_ACCOUNTS.ibrahim,
      role: 'owner',
      membershipExpiresAt: null,
      preset: b.preset,
      timezone: b.timezone,
      currency: b.currency,
      memberCount: 1,
      thingCount: 0,
      pendingInviteCount: 0,
      require2fa: false,
      modules: [],
      providerResolved: false,
    };
    state.locations.push(created);
    state.members[created.id] = {
      members: [
        {
          membershipId: uuid(),
          userId: state.me.user.id,
          displayName: state.me.user.displayName,
          email: state.me.user.email,
          username: null,
          role: 'owner',
          expiresAt: null,
          managed: false,
          managedByName: null,
          lastActiveAt: new Date().toISOString(),
          twoFactorEnabled: state.me.user.twoFactorEnabled,
          isYou: true,
          rowVersion: 1,
        },
      ],
      invites: [],
    };
    return reply(201, created);
  });
  add('GET', paths.location(':id'), ({ params }) => {
    const found = loc(params.id ?? '');
    return requireSession() ?? found ?? err(404, 'not_found', 'Not found.');
  });
  // Added after GET location(':id'), so it is matched first (`add` puts new routes in front).
  add(
    'GET',
    paths.locationsDeleted,
    () => requireSession() ?? { locations: state.deletedLocations, nextCursor: null },
  );
  add('POST', paths.locationRestore(':id'), ({ params }) => {
    const gone = state.deletedLocations.find((d) => d.id === params.id);
    // The definer's answer for anything not yours or past its grace period.
    if (!gone || Date.parse(gone.purgeAfter) < Date.now())
      return err(404, 'not_found', 'Not found.');
    state.deletedLocations = state.deletedLocations.filter((d) => d.id !== gone.id);
    const restored: LocationDetail = {
      id: gone.id,
      name: gone.name,
      kind: gone.kind,
      ownerAccountId: MOCK_ACCOUNTS.ibrahim,
      role: 'owner',
      membershipExpiresAt: null,
      preset: 'household',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      memberCount: 1,
      thingCount: 0,
      pendingInviteCount: 0,
      require2fa: false,
      modules: [],
      providerResolved: false,
    };
    state.locations.push(restored);
    return restored;
  });
  // PATCH a location's settings (D204 languages first); the real server also checks If-Match.
  add('PATCH', paths.location(':id'), ({ params, body }) => {
    const found = loc(params.id ?? '');
    if (!found) return err(404, 'not_found', 'Not found.');
    Object.assign(found, body as Partial<LocationDetail>);
    found.rowVersion = (found.rowVersion ?? 0) + 1;
    return found;
  });
  add('POST', paths.locationModules(':id'), ({ params, body }) => {
    const found = loc(params.id ?? '');
    if (!found) return err(404, 'not_found', 'Not found.');
    const b = body as SetModulesBody;
    found.preset = b.preset;
    found.modules = [...b.modules];
    return found;
  });
  add('GET', paths.locationMembers(':id'), ({ params }) => {
    const found = state.members[params.id ?? ''];
    return requireSession() ?? found ?? err(404, 'not_found', 'Not found.');
  });
  add('PATCH', paths.locationMember(':id', ':membershipId'), ({ params, body }) => {
    const list = state.members[params.id ?? '']?.members ?? [];
    const m = list.find((x) => x.membershipId === params.membershipId);
    if (!m) return err(404, 'not_found', 'Not found.');
    Object.assign(m, body as UpdateMemberBody);
    return m;
  });
  add('DELETE', paths.locationMember(':id', ':membershipId'), ({ params }) => {
    const entry = state.members[params.id ?? ''];
    if (!entry) return err(404, 'not_found', 'Not found.');
    const leaving = entry.members.find((x) => x.membershipId === params.membershipId);
    entry.members = entry.members.filter((x) => x.membershipId !== params.membershipId);
    if (leaving?.isYou) state.locations = state.locations.filter((l) => l.id !== params.id);
    return reply(204);
  });
  add('POST', paths.locationInvites(':id'), ({ params, body }) => {
    const b = body as CreateInviteBody;
    const entry = state.members[params.id ?? ''];
    const token = 'K7q2Rm9TxVd4';
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    entry?.invites.push({
      id: uuid(),
      role: b.role,
      expiresAt,
      membershipExpiresAt: b.membershipExpiresAt ?? null,
      email: b.email ?? null,
      createdByName: state.me.user.displayName,
      createdAt: new Date().toISOString(),
    });
    const origin = typeof location === 'undefined' ? 'http://kept.test' : location.origin;
    const emailed = !!b.email;
    return reply(201, {
      id: uuid(),
      role: b.role,
      // Like the server: an email invite's link goes only to the mailbox.
      url: emailed ? null : `${origin}/invite#${token}`,
      qrSvg: null,
      expiresAt,
      membershipExpiresAt: b.membershipExpiresAt ?? null,
      email: b.email ?? null,
      emailed,
    });
  });
  add('DELETE', paths.locationInvite(':id', ':inviteId'), ({ params }) => {
    const entry = state.members[params.id ?? ''];
    if (entry) entry.invites = entry.invites.filter((i) => i.id !== params.inviteId);
    return reply(204);
  });
  add('POST', paths.locationManagedAccounts(':id'), ({ body }) => {
    const b = body as CreateManagedBody;
    return reply(201, {
      userId: uuid(),
      username: b.username,
      displayName: b.displayName,
      membershipId: uuid(),
      role: b.role,
      expiresAt: b.expiresAt ?? null,
      code: 'K7Q2M9TX',
      codeExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
  // D197: the home location's owner, or its creator while an owner or admin there. The mock
  // treats the location the account is managed in as its home, and its owner as allowed.
  add('POST', paths.managedResetCode(':userId'), ({ params }) => {
    const homes = Object.entries(state.members).filter(([, e]) =>
      e.members.some((m) => m.userId === params.userId && m.managed),
    );
    if (homes.length === 0) return err(404, 'not_found', 'Not found.');
    if (!homes.some(([id]) => loc(id)?.role === 'owner'))
      return err(403, 'forbidden', "Only the owner of the account's home location can reset it.");
    return { code: 'Q4M7K2XP', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  });
  add('GET', paths.invite(':token'), ({ params }) => {
    const found = state.invites[params.token ?? ''];
    return found ?? err(404, 'invite_invalid', 'The invite is not valid.');
  });
  add('POST', paths.inviteAccept(':token'), ({ params, body }) => {
    const found = state.invites[params.token ?? ''];
    if (!found) return err(404, 'invite_invalid', 'The invite is not valid.');
    const b = (body ?? {}) as AcceptInviteBody;
    if (!state.signedIn && !b.newAccount)
      return err(401, 'unauthenticated', 'Sign in to continue.');
    delete state.invites[params.token ?? ''];
    if (b.newAccount) {
      // Like the server: the account exists and has joined, but isn't signed in (202).
      state.password = b.newAccount.password;
      state.me.user.twoFactorEnabled = false;
      state.me.user.displayName = b.newAccount.displayName;
      return reply(202, { next: 'sign-in' });
    }
    return {
      locationId: state.locations[1]?.id ?? state.locations[0]?.id ?? uuid(),
      alreadyMember: false,
    };
  });

  // ----- admin -----------------------------------------------------------------------------------
  add('GET', paths.admin.users, () => requireAdmin() ?? { users: state.admin.users });
  // Accounts for the instance cap's override picker: one per user who owns a location.
  add('GET', paths.admin.accounts, ({ query }) => {
    const gate = requireAdmin();
    if (gate) return gate;
    const q = (query.get('q') ?? '').toLocaleLowerCase();
    const items = state.admin.users
      .filter((u) => u.roles.owner > 0 && u.displayName.toLocaleLowerCase().includes(q))
      .map((u, i) => ({
        id:
          u.displayName === 'Ibrahim'
            ? MOCK_ACCOUNTS.ibrahim
            : `01926f00-0000-7000-8000-0000000ad${String(i).padStart(3, '0')}`,
        ownerName: u.displayName,
        locations: u.roles.owner,
      }));
    return { items };
  });
  for (const action of ['disable', 'enable', 'reset-2fa', 'sign-out-everywhere'] as const) {
    add('POST', paths.admin.userAction(':id', action), ({ params }) => {
      const u = state.admin.users.find((x) => x.id === params.id);
      if (!u) return err(404, 'not_found', 'Not found.');
      if (action === 'disable') u.disabled = true;
      if (action === 'enable') u.disabled = false;
      if (action === 'reset-2fa') u.twoFactorEnabled = false;
      return reply(204);
    });
  }
  add('POST', paths.admin.instanceAdmins, ({ body }) => {
    const gate = requireAdmin();
    if (gate) return gate;
    const u = state.admin.users.find((x) => x.id === (body as { userId: string }).userId);
    if (!u) return err(404, 'not_found', 'Not found.');
    if (u.managed) return err(409, 'conflict', 'A managed account cannot be an instance admin.');
    if (u.disabled) return err(409, 'conflict', 'Enable the account first.');
    if (u.instanceAdmin) return err(409, 'conflict', 'They are already an instance admin.');
    u.instanceAdmin = true;
    return reply(201, { userId: u.id, grantedAt: new Date().toISOString() });
  });
  add('DELETE', paths.admin.instanceAdmin(':userId'), ({ params }) => {
    const gate = requireAdmin();
    if (gate) return gate;
    const u = state.admin.users.find((x) => x.id === params.userId);
    if (!u?.instanceAdmin) return err(404, 'not_found', 'Not found.');
    if (state.admin.users.filter((x) => x.instanceAdmin).length <= 1)
      return err(409, 'conflict', 'Kept needs at least one instance admin.');
    u.instanceAdmin = false;
    if (u.id === state.me.user.id) state.me.user.instanceAdmin = false;
    return reply(204);
  });
  // As admin/routes.ts: the environment's values are locked (409 on a PUT), and barcode lookup
  // is the same switch the scan mock reads (`capture.barcodeLookup`).
  const settings = (): AdminSettings => {
    const s = state.admin.settings;
    if (!s.barcodeLookup.locked)
      s.barcodeLookup = { value: state.capture.barcodeLookup, locked: false };
    // Step 8 (T11): the update check's switch is the ops mock's state.
    const u = ops(state).updates;
    s.updateCheck = { value: u.enabled, locked: u.locked };
    return s;
  };
  add('GET', paths.admin.settings, () => requireAdmin() ?? settings());
  add('PUT', paths.admin.settings, ({ body }) => {
    const gate = requireAdmin();
    if (gate) return gate;
    const b = body as AdminSettingsBody;
    const s = settings();
    const known = [
      'signupOpen',
      'barcodeLookup',
      'barcodeContact',
      'formerHostnames',
      'ssrfAllowPrivate',
      'updateCheck',
    ];
    if (Object.keys(b).some((k) => !known.includes(k)))
      return err(400, 'validation', 'The request is not valid.');
    if (b.barcodeContact !== undefined && b.barcodeContact !== null) {
      const c = b.barcodeContact.trim();
      if (c.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c))
        return err(400, 'validation', 'The request is not valid.', 'barcodeContact: an email');
    }
    let hosts: string[] | undefined;
    if (b.formerHostnames !== undefined) {
      hosts = b.formerHostnames.map((h) => h.trim().toLowerCase());
      if (hosts.length > MAX_FORMER_HOSTNAMES || hosts.some((h) => !HOSTNAME.test(h)))
        return err(400, 'validation', 'The request is not valid.', 'formerHostnames: host names');
      if (hosts.includes(window.location.hostname.toLowerCase()))
        return err(
          400,
          'validation',
          'The request is not valid.',
          "formerHostnames: the public URL's own host can't be a former one.",
        );
    }
    if (b.signupOpen !== undefined) {
      if (s.signupOpen.locked) return err(409, 'conflict', 'Set by the environment.');
      s.signupOpen = { value: b.signupOpen, locked: false };
    }
    if (b.barcodeLookup !== undefined) {
      if (s.barcodeLookup.locked) return err(409, 'conflict', 'Set by the environment.');
      s.barcodeLookup = { value: b.barcodeLookup, locked: false };
      state.capture.barcodeLookup = b.barcodeLookup;
    }
    if (b.barcodeContact !== undefined) {
      if (s.barcodeContact.locked) return err(409, 'conflict', 'Set by the environment.');
      s.barcodeContact = { value: b.barcodeContact?.trim() || null, locked: false };
    }
    if (hosts) s.formerHostnames = [...new Set(hosts)];
    if (b.ssrfAllowPrivate !== undefined) s.ssrfAllowPrivate = b.ssrfAllowPrivate;
    if (b.updateCheck !== undefined) {
      const u = ops(state).updates;
      if (u.locked) return err(409, 'conflict', 'Set by the environment.');
      ops(state).updates = {
        ...u,
        enabled: b.updateCheck,
        ...(b.updateCheck ? {} : { latest: null, error: null }),
      };
      s.updateCheck = { value: b.updateCheck, locked: false };
    }
    return s;
  });
  add('GET', paths.admin.failedJobs, () => requireAdmin() ?? { jobs: state.admin.jobs });
  for (const action of ['retry', 'discard'] as const) {
    add('POST', paths.admin.failedJobAction(':id', action), ({ params }) => {
      state.admin.jobs = state.admin.jobs.filter((j) => j.id !== params.id);
      return reply(204);
    });
  }
  add('GET', paths.admin.alerts, () => requireAdmin() ?? { alerts: state.admin.alerts });
  add('GET', paths.admin.status, () => requireAdmin() ?? state.admin.status);
  add('POST', paths.admin.recoveryKitAcknowledge, () => {
    state.admin.status.recoveryKitAcknowledged = true;
    state.me.instance.recoveryKitAcknowledged = true;
    return { acknowledgedAt: new Date().toISOString() };
  });

  // ----- step 2: inventory, one handler array per area (api/inventory/mock/*) ---------------------
  // Added after step 1's, and `add` puts each new route first, so an area can override a path.
  for (const r of inventoryMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 3: capture, inbox, AI, labels, scan, imports, templates, undo, sync -----------------
  for (const r of captureMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 4: money, warranties, lending, schedules, paperwork, agenda, notifications, … ------
  for (const r of householdMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 5: vehicles, fuel, costs, readings finished, service drafts, vehicle documents ----
  // After step 4's, so it extends step 2's and step 4's routes it adds fields to.
  for (const r of vehicleMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 6: the assistant, and Connections (tokens, OAuth consent, webhooks) ---------------
  for (const r of assistantMockRoutes(state)) add(r.method, r.template, r.handler);
  for (const r of connectionsMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 7: archive imports, exports, enrichment, consumables, field conversion ------------
  for (const r of portabilityMockRoutes(state)) add(r.method, r.template, r.handler);
  // ----- step 8: backups, the status page's new fields, the recovery kit, updates, keep offline ---
  for (const r of opsMockRoutes(state)) add(r.method, r.template, r.handler);

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://kept.test',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : (init?.body ?? undefined);
    } catch {
      body = raw; // a raw upload (PUT /files/:id) or plain text
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers as Record<string, string> | undefined) ?? {},
    ))
      headers[k.toLowerCase()] = v;
    calls.push({ method, path: url.pathname, body, headers });
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = decodeURIComponent(v);
      const eventsBefore = state.inventory.events.length;
      const out = await r.handler({
        method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers,
        body,
      });
      if (out === PASS) continue;
      // A handler that isn't JSON (the AI calls' CSV export) answers with its own Response.
      if (out instanceof Response) return out;
      const res = out instanceof MockReply ? out : reply(200, out);
      // Like the server's scopedWrite (http/write.ts): a write that recorded undoable events
      // names them in X-Kept-Audit-Event, comma-separated in write order; otherwise no header.
      const undoable =
        method !== 'GET' && res.status < 300
          ? state.inventory.events
              .slice(eventsBefore)
              .filter((e) => e.undoable_until)
              .map((e) => e.id)
          : [];
      return new Response(
        res.status === 204 || res.body === undefined ? null : JSON.stringify(res.body),
        {
          status: res.status,
          headers: {
            'content-type': 'application/json',
            ...(undoable.length > 0 ? { [AUDIT_EVENT_HEADER]: undoable.join(', ') } : {}),
          },
        },
      );
    }
    return new Response(JSON.stringify({ error: 'Not found.', code: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: mockFetch,
    state,
    calls,
    on: add,
    hang: (method, template) => add(method, template, () => new Promise(() => {})),
    lastCall: (method, path) =>
      [...calls].reverse().find((c) => c.method === method && c.path === path),
  };
}
