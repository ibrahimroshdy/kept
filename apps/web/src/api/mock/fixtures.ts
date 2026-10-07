/**
 * The Cairo household from the screens board (docs/design/screens/06-people-types.html): Ibrahim
 * owns Home; his brother Bruce is an admin; Alfred is a member; Louis is house-sitting as a member
 * until 31 Oct; Peter, Alfred's son, has a managed account; Talia is a viewer. Shared by tests
 * and the demo mode. Every scenario is a fresh object, so a test can mutate it freely.
 */

import { type CaptureState, captureFixtures } from '../capture/mock/state';
import { type HouseholdState, householdFixtures } from '../household/mock/state';
import type { InventoryState } from '../inventory/mock/db';
import { familyLocation, inventoryFixtures } from '../inventory/mock/fixtures';
import type {
  AdminAlert,
  AdminSettings,
  AdminStatus,
  AdminUser,
  DeletedLocation,
  DeviceSession,
  FailedJob,
  InvitePreview,
  LocationDetail,
  Me,
  MembersResponse,
  VersionInfo,
} from '../types';

export type MockState = {
  setupNeeded: boolean;
  setupCode: string;
  signedIn: boolean;
  mfaPending: boolean;
  twoFactorCookie: boolean;
  enrolling: boolean;
  password: string;
  totpCode: string;
  magicToken: string;
  backupCodes: string[];
  version: VersionInfo;
  me: Me;
  locations: LocationDetail[];
  members: Record<string, MembersResponse>;
  invites: Record<string, InvitePreview>;
  sessions: DeviceSession[];
  /** The caller's own deleted locations in their grace period (D149), newest first. */
  deletedLocations: DeletedLocation[];
  /**
   * The session signed in within the last 10 minutes: an email change needs no password then
   * (only for accounts with no password on the server; the mock treats it as "no password
   * needed", D176).
   */
  freshSignIn: boolean;
  /** Email-change links not used yet: token → which step it confirms (D176). */
  emailChangeTokens: Record<string, { stage: 'old' | 'new'; newEmail: string }>;
  admin: {
    users: AdminUser[];
    settings: AdminSettings;
    jobs: FailedJob[];
    alerts: AdminAlert[];
    status: AdminStatus;
  };
  /** Step 2: places, things, registries, search, files, trash, home (api/inventory/mock). */
  inventory: InventoryState;
  /** Step 3: capture, inbox, AI, labels, scan, imports, templates, undo, sync (api/capture/mock). */
  capture: CaptureState;
  /**
   * Step 4: money, warranties, lending, schedules, paperwork, the agenda, notifications, the
   * calendar feed and incidents (api/household/mock).
   */
  household: HouseholdState;
};

/** An ISO time `hours` before now, so "active 2 hours ago" stays true whenever it runs. */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
/** An ISO time `days` from now. */
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const CAIRO_PROFILE: Me['profile'] = {
  timezone: 'Africa/Cairo',
  locale: 'en',
  units: 'metric',
  theme: 'system',
  digits: 'western',
};

let seq = 0;
/** Deterministic UUIDv7-shaped ids, so snapshots and URLs are stable. */
export function uuid(): string {
  seq += 1;
  return `01926f00-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

export const IDS = {
  ibrahim: '01926f00-0000-7000-8000-00000000a001',
  personal: '01926f00-0000-7000-8000-00000000b001',
  home: '01926f00-0000-7000-8000-00000000b002',
  garage: '01926f00-0000-7000-8000-00000000b003',
  alfredPersonal: '01926f00-0000-7000-8000-00000000b004',
  /** بيت العائلة, Bruce's Arabic household; Ibrahim is a member (api/inventory/mock/fixtures.ts). */
  family: '01926f00-0000-7000-8000-00000000b005',
  /** Ibrahim's deleted "Beach flat", restorable for 27 more days (D149). */
  beach: '01926f00-0000-7000-8000-00000000b006',
} as const;

export const INVITE_TOKEN = 'K7q2Rm9TxVd4';
export const MAGIC_TOKEN = 'mL4gic-T0ken';
/** The link mailed to the current address (step 1 of an email change, D176). */
export const EMAIL_CHANGE_OLD_TOKEN = 'eC-old-T0ken';
/** The link mailed to the new address (the last step). */
export const EMAIL_CHANGE_NEW_TOKEN = 'eC-new-T0ken';

/** The accounts that own the fixture locations (`ownerAccountId`, T25 decision 1). */
export const MOCK_ACCOUNTS = {
  ibrahim: '01926f00-0000-7000-8000-0000000ac001',
  alfred: '01926f00-0000-7000-8000-0000000ac003',
} as const;

const personal = (
  id: string,
  things = 0,
  account: string = MOCK_ACCOUNTS.ibrahim,
): LocationDetail => ({
  id,
  name: 'Personal',
  kind: 'personal',
  ownerAccountId: account,
  role: 'owner',
  membershipExpiresAt: null,
  preset: 'household',
  timezone: 'Africa/Cairo',
  currency: 'EGP',
  memberCount: 1,
  thingCount: things,
  pendingInviteCount: 0,
  require2fa: false,
  modules: ['labels', 'money', 'warranties', 'schedules', 'lending', 'paperwork', 'vehicles'],
  providerResolved: false,
});

const home = (): LocationDetail => ({
  id: IDS.home,
  name: 'Home',
  kind: 'apartment',
  ownerAccountId: MOCK_ACCOUNTS.ibrahim,
  role: 'owner',
  membershipExpiresAt: null,
  preset: 'household',
  timezone: 'Africa/Cairo',
  currency: 'EGP',
  memberCount: 6,
  thingCount: 214,
  pendingInviteCount: 1,
  require2fa: true,
  // Consumables on (step-7 T23): the AA batteries keep at least 16 and run low.
  modules: [
    'labels',
    'money',
    'warranties',
    'schedules',
    'lending',
    'paperwork',
    'vehicles',
    'consumables',
  ],
  providerResolved: false,
});

const garage = (): LocationDetail => ({
  id: IDS.garage,
  name: 'Garage',
  kind: 'garage',
  ownerAccountId: MOCK_ACCOUNTS.ibrahim,
  role: 'owner',
  membershipExpiresAt: null,
  preset: 'essentials',
  timezone: 'Africa/Cairo',
  currency: 'EGP',
  memberCount: 1,
  thingCount: 63,
  pendingInviteCount: 0,
  require2fa: false,
  // Essentials, with Lending turned on over the preset: tools get lent from the garage (the
  // step-4 drill lent to Murdock). Money, warranties, schedules and paperwork stay off, the
  // module-off variant step-4 screens test against.
  modules: ['labels', 'lending'],
  providerResolved: false,
});

const homeMembers = (): MembersResponse => ({
  members: [
    {
      membershipId: 'm-ibrahim',
      userId: IDS.ibrahim,
      displayName: 'Ibrahim',
      email: 'ibrahim@example.com',
      username: null,
      role: 'owner',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(0.2),
      twoFactorEnabled: true,
      isYou: true,
      rowVersion: 3,
    },
    {
      membershipId: 'm-bruce',
      userId: 'u-bruce',
      displayName: 'Bruce',
      email: 'bruce@example.com',
      username: null,
      role: 'admin',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(9),
      twoFactorEnabled: true,
      isYou: false,
      rowVersion: 3,
    },
    {
      membershipId: 'm-alfred',
      userId: 'u-alfred',
      displayName: 'Alfred',
      email: 'alfred@example.com',
      username: null,
      role: 'member',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(2),
      twoFactorEnabled: true,
      isYou: false,
      rowVersion: 3,
    },
    {
      membershipId: 'm-louis',
      userId: 'u-louis',
      displayName: 'Louis',
      email: 'louis@example.com',
      username: null,
      role: 'member',
      expiresAt: inDays(35),
      managed: false,
      managedByName: null,
      lastActiveAt: ago(40),
      twoFactorEnabled: false,
      isYou: false,
      rowVersion: 3,
    },
    {
      membershipId: 'm-peter',
      userId: 'u-peter',
      displayName: 'Peter',
      email: null,
      username: 'peter',
      role: 'member',
      expiresAt: null,
      managed: true,
      managedByName: 'Alfred',
      lastActiveAt: ago(120),
      twoFactorEnabled: false,
      isYou: false,
      rowVersion: 3,
    },
    {
      membershipId: 'm-talia',
      userId: 'u-talia',
      displayName: 'Talia',
      email: 'talia@example.com',
      username: null,
      role: 'viewer',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(72),
      twoFactorEnabled: true,
      isYou: false,
      rowVersion: 3,
    },
  ],
  invites: [
    {
      id: 'inv-1',
      role: 'member',
      expiresAt: inDays(6),
      membershipExpiresAt: null,
      email: null,
      createdByName: 'Bruce',
      createdAt: ago(3),
    },
  ],
});

const soloMembers = (userId: string, name: string): MembersResponse => ({
  members: [
    {
      membershipId: `m-${userId}`,
      userId,
      displayName: name,
      email: 'ibrahim@example.com',
      username: null,
      role: 'owner',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(0.2),
      twoFactorEnabled: true,
      isYou: true,
      rowVersion: 3,
    },
  ],
  invites: [],
});

/** بيت العائلة: Bruce owns it; Ibrahim is a member. */
const familyMembers = (): MembersResponse => ({
  members: [
    {
      membershipId: 'm-family-bruce',
      userId: 'u-bruce',
      displayName: 'بروس',
      email: 'bruce@example.com',
      username: null,
      role: 'owner',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(3),
      twoFactorEnabled: true,
      isYou: false,
      rowVersion: 1,
    },
    {
      membershipId: 'm-family-ibrahim',
      userId: IDS.ibrahim,
      displayName: 'Ibrahim',
      email: 'ibrahim@example.com',
      username: null,
      role: 'member',
      expiresAt: null,
      managed: false,
      managedByName: null,
      lastActiveAt: ago(0.2),
      twoFactorEnabled: true,
      isYou: true,
      rowVersion: 1,
    },
  ],
  invites: [],
});

const adminUsers = (): AdminUser[] => [
  {
    id: IDS.ibrahim,
    displayName: 'Ibrahim',
    email: 'ibrahim@example.com',
    username: null,
    managed: false,
    instanceAdmin: true,
    disabled: false,
    twoFactorEnabled: true,
    createdAt: '2026-09-01T10:00:00Z',
    roles: { owner: 3, admin: 0, member: 0, viewer: 0 },
  },
  {
    id: 'u-bruce',
    displayName: 'Bruce',
    email: 'bruce@example.com',
    username: null,
    managed: false,
    instanceAdmin: false,
    disabled: false,
    twoFactorEnabled: true,
    createdAt: '2026-09-03T10:00:00Z',
    roles: { owner: 1, admin: 1, member: 0, viewer: 0 },
  },
  {
    id: 'u-louis',
    displayName: 'Louis',
    email: 'louis@example.com',
    username: null,
    managed: false,
    instanceAdmin: false,
    disabled: false,
    twoFactorEnabled: false,
    createdAt: '2026-09-20T10:00:00Z',
    roles: { owner: 1, admin: 0, member: 1, viewer: 0 },
  },
  {
    id: 'u-peter',
    displayName: 'Peter',
    email: null,
    username: 'peter',
    managed: true,
    instanceAdmin: false,
    disabled: false,
    twoFactorEnabled: false,
    createdAt: '2026-09-10T10:00:00Z',
    roles: { owner: 1, admin: 0, member: 1, viewer: 0 },
  },
  {
    id: 'u-old',
    displayName: 'Antar',
    email: 'tamer@example.com',
    username: null,
    managed: false,
    instanceAdmin: false,
    disabled: true,
    twoFactorEnabled: false,
    createdAt: '2026-09-05T10:00:00Z',
    roles: { owner: 1, admin: 0, member: 0, viewer: 0 },
  },
];

const sessions = (): DeviceSession[] => [
  {
    id: 's-1',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    ipAddress: '192.168.1.20',
    createdAt: '2026-09-20T10:00:00Z',
    lastActiveAt: ago(0.2),
    current: true,
    secondFactor: true,
  },
  {
    id: 's-2',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    ipAddress: '192.168.1.31',
    createdAt: '2026-09-02T08:00:00Z',
    lastActiveAt: ago(5),
    current: false,
    secondFactor: false,
  },
  {
    id: 's-3',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    ipAddress: '10.0.0.4',
    createdAt: '2026-09-11T08:00:00Z',
    lastActiveAt: ago(24 * 12),
    current: false,
    secondFactor: false,
  },
];

function base(): MockState {
  return {
    setupNeeded: false,
    setupCode: 'K7Q2M9',
    signedIn: true,
    mfaPending: false,
    twoFactorCookie: false,
    enrolling: false,
    password: 'correct horse battery',
    totpCode: '123456',
    magicToken: MAGIC_TOKEN,
    backupCodes: ['a1b2c-d3e4f', 'g5h6j-k7m8n', 'p9q1r-s2t3v', 'w4x5y-z6a7b', 'c8d9e-f1g2h'],
    version: {
      version: '0.1.0',
      revision: '3f9ed1d',
      source: 'https://github.com/ibrahimroshdy/kept/tree/3f9ed1d',
    },
    me: {
      user: {
        id: IDS.ibrahim,
        displayName: 'Ibrahim',
        email: 'ibrahim@example.com',
        username: null,
        twoFactorEnabled: true,
        managed: false,
        instanceAdmin: true,
      },
      mfa: true,
      personalLocationId: IDS.personal,
      profile: CAIRO_PROFILE,
      memberships: [],
      instance: { recoveryKitAcknowledged: false },
    },
    locations: [personal(IDS.personal, 9), home(), garage(), familyLocation()],
    members: {
      [IDS.personal]: soloMembers(IDS.ibrahim, 'Ibrahim'),
      [IDS.home]: homeMembers(),
      [IDS.garage]: soloMembers(IDS.ibrahim, 'Ibrahim'),
      [IDS.family]: familyMembers(),
    },
    invites: {
      [INVITE_TOKEN]: {
        location: { name: 'Home', kind: 'apartment' },
        inviterName: 'Ibrahim',
        role: 'member',
        membershipExpiresAt: inDays(35),
        expiresAt: inDays(6),
        require2fa: true,
        emailBound: false,
        alreadyMemberLocationId: null,
      },
    },
    sessions: sessions(),
    deletedLocations: [
      {
        id: IDS.beach,
        name: 'Beach flat',
        kind: 'vacation_home',
        deletedAt: ago(24 * 3),
        purgeAfter: inDays(27),
      },
    ],
    freshSignIn: false,
    emailChangeTokens: {
      [EMAIL_CHANGE_OLD_TOKEN]: { stage: 'old', newEmail: 'ibrahim@new.example' },
      [EMAIL_CHANGE_NEW_TOKEN]: { stage: 'new', newEmail: 'ibrahim@new.example' },
    },
    admin: {
      users: adminUsers(),
      settings: {
        signupOpen: { value: false, locked: false },
        barcodeLookup: { value: false, locked: false },
        barcodeContact: { value: null, locked: false },
        formerHostnames: [],
        ssrfAllowPrivate: false,
      },
      jobs: [
        {
          id: 'job-1',
          name: 'notify-owner-new-member',
          createdAt: ago(8),
          failedAt: ago(7),
          attempts: 3,
          error: 'SMTP connection refused (127.0.0.1:1025)',
        },
        {
          id: 'job-2',
          name: 'repair-orphans',
          createdAt: ago(2),
          failedAt: ago(1),
          attempts: 5,
          error: null,
        },
      ],
      alerts: [
        {
          id: 'al-1',
          kind: 'failed_jobs_rising',
          firstAt: ago(7),
          lastAt: ago(1),
          count: 3,
          resolvedAt: null,
          payload: { failedLastHour: 12, byQueue: { 'notify-owner-new-member': 12 } },
        },
        {
          id: 'al-2',
          kind: 'failed_jobs_rising',
          firstAt: ago(24 * 8),
          lastAt: ago(24 * 8 - 1),
          count: 1,
          resolvedAt: ago(24 * 8 - 2),
          payload: { failedLastHour: 6, byQueue: { 'repair-orphans': 6 } },
        },
      ],
      status: {
        version: '0.1.0',
        dbOk: true,
        alerts: 1,
        recoveryKitAcknowledged: false,
        mail: { configured: true },
        reminders: { lastRunAt: ago(0.1), lastOkAt: ago(0.1), occurrences: 3, durationMs: 412 },
      },
    },
    inventory: inventoryFixtures(),
    capture: captureFixtures(IDS.ibrahim),
    household: householdFixtures(IDS.ibrahim),
  };
}

/** Ibrahim: owner of Home and Garage, instance admin. The fullest Home. */
export function ownerScenario(): MockState {
  return base();
}

/** Right after first-run setup: only the Personal location exists (screens §8, D114). */
export function firstRunScenario(): MockState {
  const s = base();
  s.locations = [personal(IDS.personal)];
  s.members = { [IDS.personal]: soloMembers(IDS.ibrahim, 'Ibrahim') };
  s.deletedLocations = [];
  s.inventory.things = [];
  s.inventory.events = [];
  s.me.user.twoFactorEnabled = false;
  s.me.mfa = false;
  return s;
}

/** Alfred: an invited member of Home (no invite or AI items for him, screens §5 Home). */
export function memberScenario(): MockState {
  const s = base();
  s.me = {
    user: {
      id: 'u-alfred',
      displayName: 'Alfred',
      email: 'alfred@example.com',
      username: null,
      twoFactorEnabled: true,
      managed: false,
      instanceAdmin: false,
    },
    mfa: true,
    personalLocationId: IDS.alfredPersonal,
    profile: CAIRO_PROFILE,
    memberships: [],
    instance: { recoveryKitAcknowledged: null },
  };
  s.locations = [
    personal(IDS.alfredPersonal, 4, MOCK_ACCOUNTS.alfred),
    { ...home(), role: 'member', pendingInviteCount: 0 },
  ];
  s.deletedLocations = [];
  return s;
}

/** A fresh server: setup is needed and nobody is signed in. */
export function setupScenario(): MockState {
  const s = firstRunScenario();
  s.setupNeeded = true;
  s.signedIn = false;
  return s;
}

/** Set up, signed out. */
export function signedOutScenario(): MockState {
  const s = base();
  s.signedIn = false;
  return s;
}

export const scenarios = {
  owner: ownerScenario,
  firstrun: firstRunScenario,
  member: memberScenario,
  setup: setupScenario,
  signedout: signedOutScenario,
} as const;

export type ScenarioName = keyof typeof scenarios;
