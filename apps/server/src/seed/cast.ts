// The seed's people and places (D152, D185): the cast of the screens board (docs/design/screens),
// the same Cairo household in October 2026. Ibrahim owns Home and runs this Kept; his brother Bruce
// is an admin; Alfred is a member; Louis is house-sitting as a member for a few weeks; Talia is a
// viewer; Peter, Alfred's son, has a managed account. Murdock, Ibrahim's other brother, stays a
// contact without an account (step 2's people), so he is not here.
//
// Deviations from the board, on purpose: the board has Peter "managed by Alfred", but Alfred is a
// member there and only owners and admins make managed accounts (D47), so Ibrahim makes him. Home
// "asks everyone for two-factor" on the board; the seed leaves require_2fa off, so every account
// signs in with its password alone in development.
//
// Step 2 (task 23) adds a Garage location of Ibrahim's, as on the board, and fills every household
// with places and things (seed/stock.ts, seed/inventory.ts).

/** Every seeded account's password: development only (the seed refuses NODE_ENV=production). */
export const SEED_PASSWORD = 'kept-seed-password';

export type PersonKey = 'ibrahim' | 'bruce' | 'alfred' | 'louis' | 'talia';
export type ManagedKey = 'peter';

export type Person = {
  email: string;
  displayName: string;
  /** Accept-Language at sign-up: the profile locale (and so the language of their mail). */
  locale: string;
  timezone: string;
};

export const PEOPLE: Record<PersonKey, Person> = {
  ibrahim: {
    email: 'ibrahim@kept.test',
    displayName: 'Ibrahim',
    locale: 'en',
    timezone: 'Africa/Cairo',
  },
  bruce: { email: 'bruce@kept.test', displayName: 'Bruce', locale: 'en', timezone: 'Africa/Cairo' },
  alfred: {
    email: 'alfred@kept.test',
    displayName: 'Alfred',
    locale: 'ar-EG',
    timezone: 'Africa/Cairo',
  },
  louis: { email: 'louis@kept.test', displayName: 'Louis', locale: 'en', timezone: 'Africa/Cairo' },
  talia: { email: 'talia@kept.test', displayName: 'Talia', locale: 'en', timezone: 'Africa/Cairo' },
};

/** The instance admin: the first account, made through first-run setup when setup is pending. */
export const INSTANCE_ADMIN: PersonKey = 'ibrahim';

export type Managed = { username: string; displayName: string };
export const MANAGED: Record<ManagedKey, Managed> = {
  peter: { username: 'peter', displayName: 'Peter' },
};

export type GrantableRole = 'admin' | 'member' | 'viewer';

export type Household<K extends string = PersonKey> = {
  name: string;
  /** locations.kind (a creatable kind, never `personal`). */
  kind: 'home' | 'garage';
  timezone: string;
  currency: string;
  /** BCP 47 tags (locations.languages). */
  languages: string[];
  owner: K;
  members: { who: K; role: GrantableRole; endsInDays?: number }[];
  managed: { who: string; role: GrantableRole; createdBy: K }[];
};

export const HOUSEHOLDS: Household[] = [
  {
    name: 'Home',
    kind: 'home',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    languages: ['en'],
    owner: 'ibrahim',
    members: [
      { who: 'bruce', role: 'admin' },
      { who: 'alfred', role: 'member' },
      // House-sitting: the membership ends on its own (D46).
      { who: 'louis', role: 'member', endsInDays: 30 },
      { who: 'talia', role: 'viewer' },
    ],
    managed: [{ who: 'peter', role: 'member', createdBy: 'ibrahim' }],
  },
  // The board's second location of Ibrahim's: the car, the tools and the shelves (screens 02, 05).
  {
    name: 'Garage',
    kind: 'garage',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    languages: ['en'],
    owner: 'ibrahim',
    members: [
      { who: 'bruce', role: 'admin' },
      // Alfred logs the Corolla's readings on the board.
      { who: 'alfred', role: 'member' },
    ],
    managed: [],
  },
  {
    name: 'بيت العائلة',
    kind: 'home',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    languages: ['ar-EG'],
    owner: 'alfred',
    members: [
      { who: 'ibrahim', role: 'admin' },
      { who: 'bruce', role: 'member' },
    ],
    managed: [],
  },
];

/** A scenario's people and locations: households.ts makes them, whichever scenario it is. */
export type Cast<K extends string = PersonKey> = {
  people: Record<K, Person>;
  /** Made through first-run setup when setup is pending. */
  instanceAdmin: K;
  managed: Record<string, Managed>;
  households: Household<K>[];
};

export const HOUSEHOLDS_CAST: Cast = {
  people: PEOPLE,
  instanceAdmin: INSTANCE_ADMIN,
  managed: MANAGED,
  households: HOUSEHOLDS,
};
