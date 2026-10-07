import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import { DIGITS, THEMES, UNITS } from '../db/schema/index.js';
import type { KeptApp } from '../http/app.js';
import { unauthenticated } from '../http/errors.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { Iso, LocationKind, RoleSchema } from '../locations/views.js';
import { auditMine } from '../notify/prefs.js';
import { RECOVERY_KIT_KEY } from '../setup/recovery-kit.js';

// GET /api/v1/me (carry-over from task 17; the web shell's first query): who is signed in, their
// display preferences, whether they are an instance admin, and the locations they belong to.
//
// PATCH /api/v1/me {suggestLocation} (step-3 carry-over, T19): "Suggest where I am" (the phone's
// location suggestion) is the person's, across devices, in user_profiles.suggest_location.
// Audited `me.preferences` on the person's own account. → 200 {suggestLocation}.

const Me = z.object({
  user: z.object({
    id: z.uuid(),
    displayName: z.string(),
    /** Null for a managed account (its address is synthetic and never shown, D47). */
    email: z.string().nullable(),
    /** A managed account's sign-in name; null otherwise. */
    username: z.string().nullable(),
    twoFactorEnabled: z.boolean(),
    managed: z.boolean(),
    instanceAdmin: z.boolean(),
  }),
  /** A second factor was proven in this session (TOTP, backup code, passkey with UV). */
  mfa: z.boolean(),
  /** Null only while it is hidden from this session (require_2fa without a second factor). */
  personalLocationId: z.uuid().nullable(),
  profile: z.object({
    timezone: z.string(),
    locale: z.string(),
    units: z.enum(UNITS),
    theme: z.enum(THEMES),
    digits: z.enum(DIGITS),
    /** "Suggest where I am" (D39's phone suggestion), off by default. */
    suggestLocation: z.boolean(),
  }),
  /** The locations this session can see, with the user's role and end date in each. */
  memberships: z.array(
    z.object({
      locationId: z.uuid(),
      name: z.string(),
      kind: LocationKind,
      role: RoleSchema,
      expiresAt: Iso.nullable(),
    }),
  ),
  instance: z.object({
    /** Instance admins only; null for everyone else (task 22 writes it, D193). */
    recoveryKitAcknowledged: z.boolean().nullable(),
  }),
});

export async function meRoutes(
  app: KeptApp,
  opts: { pools: Pick<Pools, 'app' | 'auth'> },
): Promise<void> {
  const { pools } = opts;

  app.get('/api/v1/me', { schema: { response: { 200: Me } } }, async (req) => {
    const kept = await scopedRead(pools, req, async (_tx, client) => {
      const profile = await client.query<{
        display_name: string;
        timezone: string;
        locale: string;
        units: (typeof UNITS)[number];
        theme: (typeof THEMES)[number];
        digits: (typeof DIGITS)[number];
        suggest_location: boolean;
        managed: boolean;
      }>(
        `SELECT display_name, timezone, locale, units, theme, digits, suggest_location, managed
           FROM public.user_profiles WHERE user_id = kept.current_user_id()`,
      );
      const memberships = await client.query<{
        location_id: string;
        name: string;
        kind: z.infer<typeof LocationKind>;
        role: z.infer<typeof RoleSchema>;
        expires_at: Date | null;
      }>(
        `SELECT l.id AS location_id, l.name, l.kind, m.role, m.expires_at
           FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
          WHERE m.user_id = kept.current_user_id()
          ORDER BY (l.kind = 'personal') DESC, lower(l.name), l.id`,
      );
      const admin = await client.query<{ admin: boolean }>(
        'SELECT kept.is_instance_admin() AS admin',
      );
      const instanceAdmin = admin.rows[0]?.admin === true;
      let recoveryKitAcknowledged: boolean | null = null;
      if (instanceAdmin) {
        const kit = await client.query('SELECT 1 FROM public.instance_settings WHERE key = $1', [
          RECOVERY_KIT_KEY,
        ]);
        recoveryKitAcknowledged = (kit.rowCount ?? 0) > 0;
      }
      return {
        profile: profile.rows[0],
        memberships: memberships.rows,
        instanceAdmin,
        recoveryKitAcknowledged,
      };
    });
    const scope = req.scope;
    if (!scope) throw unauthenticated();
    const { rows } = await pools.auth.query<{
      email: string;
      username: string | null;
      two_factor_enabled: boolean | null;
    }>('SELECT email, username, two_factor_enabled FROM auth."user" WHERE id = $1', [scope.userId]);
    const user = rows[0];
    if (!user) throw unauthenticated();
    const managed = kept.profile?.managed === true;
    const personal = kept.memberships.find((m) => m.kind === 'personal' && m.role === 'owner');
    return {
      user: {
        id: scope.userId,
        displayName: kept.profile?.display_name ?? '',
        email: managed ? null : user.email,
        username: managed ? user.username : null,
        twoFactorEnabled: user.two_factor_enabled === true,
        managed,
        instanceAdmin: kept.instanceAdmin,
      },
      mfa: scope.mfa,
      personalLocationId: personal?.location_id ?? null,
      profile: {
        timezone: kept.profile?.timezone ?? 'UTC',
        locale: kept.profile?.locale ?? 'en',
        units: kept.profile?.units ?? 'metric',
        theme: kept.profile?.theme ?? 'system',
        digits: kept.profile?.digits ?? 'western',
        suggestLocation: kept.profile?.suggest_location === true,
      },
      memberships: kept.memberships.map((m) => ({
        locationId: m.location_id,
        name: m.name,
        kind: m.kind,
        role: m.role,
        expiresAt: m.expires_at?.toISOString() ?? null,
      })),
      instance: { recoveryKitAcknowledged: kept.recoveryKitAcknowledged },
    };
  });

  const Patch = z.object({ suggestLocation: z.boolean() }).strict();
  app.patch(
    '/api/v1/me',
    {
      schema: {
        body: Patch,
        response: { 200: z.object({ suggestLocation: z.boolean() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { rows } = await client.query<{ suggest_location: boolean }>(
          `SELECT suggest_location FROM public.user_profiles
            WHERE user_id = kept.current_user_id() FOR UPDATE`,
        );
        const before = rows[0]?.suggest_location;
        if (before === undefined) throw unauthenticated();
        const want = req.body.suggestLocation;
        if (before !== want) {
          await client.query(
            'UPDATE public.user_profiles SET suggest_location = $1 WHERE user_id = kept.current_user_id()',
            [want],
          );
          await auditMine(tx, scope.userId, {
            action: 'me.preferences',
            entity: { type: 'user', id: scope.userId },
            before: { suggest_location: before },
            after: { suggest_location: want },
            requestId: req.id,
          });
        }
        return { status: 200, body: { suggestLocation: want } };
      }),
  );
}
