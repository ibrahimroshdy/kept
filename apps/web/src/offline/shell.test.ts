/**
 * The frame's last-known state for a cold start offline (shell.ts, shell-db.ts): only what the
 * shell reads, never the email; it lives in the person's own database and goes with the cache on
 * a 401 (D181, D210).
 */
import { newId } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import type { LocationDetail, Me } from '@/api/types';
import { fakeIdb, makeDexieStore } from '@/test/dexie';
import { readShell, shellOf } from './shell';
import { shellFromDb } from './shell-db';
import { lockUserDb } from './wipe';

const me = (id: string): Me => ({
  user: {
    id,
    displayName: 'Alfred',
    email: 'alfred@kept.test',
    username: null,
    twoFactorEnabled: false,
    managed: false,
    instanceAdmin: false,
  },
  mfa: false,
  personalLocationId: '01926f00-0000-7000-8000-00000000b001',
  profile: {
    timezone: 'Africa/Cairo',
    locale: 'ar-EG',
    units: 'metric',
    theme: 'system',
    digits: 'eastern',
  },
  memberships: [
    {
      locationId: '01926f00-0000-7000-8000-00000000b002',
      name: 'بيت العائلة',
      kind: 'home',
      role: 'owner',
      expiresAt: null,
    },
  ],
  instance: { recoveryKitAcknowledged: null },
});

const home: LocationDetail = {
  id: '01926f00-0000-7000-8000-00000000b002',
  name: 'بيت العائلة',
  kind: 'home',
  ownerAccountId: '01926f00-0000-7000-8000-00000000a001',
  role: 'owner',
  membershipExpiresAt: null,
  preset: 'household',
  timezone: 'Africa/Cairo',
  currency: 'EGP',
  memberCount: 2,
  thingCount: 40,
  pendingInviteCount: 0,
  require2fa: false,
  modules: ['labels'],
  providerResolved: true,
  effectiveModules: ['labels', 'ai_capture'],
  languages: ['ar', 'en'],
  rowVersion: 7,
  moneyVisibleToViewers: false,
  successorUserId: '01926f00-0000-7000-8000-00000000c001',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('the shell copy', () => {
  it('keeps only what the frame reads: no email, no version, successor or money setting', () => {
    const s = shellOf(me('u1'), [home], 1_000);
    expect(s.me.user.email).toBeNull();
    expect(s.me.user.displayName).toBe('Alfred');
    expect(s.me.profile).toEqual(me('u1').profile);
    expect(s.locations[0]).not.toHaveProperty('rowVersion');
    expect(s.locations[0]).not.toHaveProperty('successorUserId');
    expect(s.locations[0]).not.toHaveProperty('moneyVisibleToViewers');
    expect(s.locations[0]?.effectiveModules).toEqual(['labels', 'ai_capture']);
    expect(JSON.stringify(s)).not.toContain('@');
  });

  it("reads back only the person's own, and nothing from a locked database", () => {
    const s = shellOf(me('u1'), [home], 1_000);
    expect(readShell(s, 'u1')).toEqual(s);
    expect(readShell(s, 'u2')).toBeNull();
    expect(readShell(s, 'u1', Date.now())).toBeNull();
    expect(readShell({ savedAt: 'x' }, 'u1')).toBeNull();
    expect(readShell(undefined, 'u1')).toBeNull();
  });

  it('lives in the person’s database, and a 401 takes it with the cache (D210)', async () => {
    const idb = fakeIdb();
    const id = newId();
    const store = makeDexieStore(id, idb);
    await store.setMeta('shell', shellOf(me(id), [home], 1_000));
    store.db.close();
    expect((await shellFromDb(id, idb))?.me.user.id).toBe(id);
    expect(await shellFromDb(newId(), idb)).toBeNull();

    await lockUserDb(id, idb);
    expect(await shellFromDb(id, idb)).toBeNull();
  });
});
