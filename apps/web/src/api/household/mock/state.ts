/**
 * The step-4 half of the mock server's state (money, warranties and claims, lending, schedules
 * and service records, paperwork, notifications and their settings, calendar feeds, incidents and
 * claim packs), and its fixtures. Built fresh per scenario, next to step 2's inventory
 * (api/inventory/mock), whose things, places, people and vendors it points at by id: every
 * response is serialised from the live inventory, so a trashed or renamed thing shows as it is.
 *
 * What the fixtures hold (plan T3), all from the sample cast:
 * - Ibrahim's Home: the Samsung TV under two warranties (the maker's 2 years and B.TECH's 3), with
 *   a claim in repair at the Samsung service centre and a valuation; the boiler service on the
 *   Kitchen, due in 10 days; the home insurance on the location, expiring in 20 days.
 * - Garage (Essentials, with Lending turned on over its preset): the Bosch drill, lent by Bruce to
 *   Murdock and 2 days overdue; a ladder borrowed from Murdock, due back in 20 days.
 * - Alfred's بيت العائلة: an Arabic lease (عقد الإيجار) on the location, with last year's term
 *   in its history.
 * - Notifications of every kind, four unread; the email channel and one phone's push
 *   subscription; a USD→EGP rate; a finished claim pack; one calendar feed.
 *
 * Murdock, the service centre and the ladder are `seed*`, added to the inventory on the first
 * step-4 request (`ensureSeeded`), so step 2's fixtures and their tests keep their counts.
 * Test and demo data only.
 */
import type { NotifyKind, PreferenceChannel } from '@kept/shared';
import type { StoredThing } from '../../inventory/mock/db';
import { INV_IDS } from '../../inventory/mock/fixtures';
import type { ActorRef, Money, Person, Vendor } from '../../inventory/types';
import type {
  CalendarFeed,
  Channel,
  Claim,
  ClaimPack,
  ExpiringDocument,
  FxRate,
  Incident,
  Loan,
  Notification,
  Schedule,
  ServiceRecord,
  SubjectInput,
  Valuation,
  Warranty,
} from '../types';

// ----- stored shapes: what the mock keeps; responses are computed from them ---------------------

export type StoredFxRate = FxRate & { accountId: string };

export type StoredValuation = Omit<Valuation, 'value'> & {
  thingId: string;
  amount: string;
  currency: string;
  createdAt: string;
};

/** `effectiveEndsOn` and `state` are computed on read (warrantyEnds, the location's today). */
export type StoredWarranty = Omit<Warranty, 'effectiveEndsOn' | 'state'>;

export type StoredClaim = Omit<
  Claim,
  'warranty' | 'incident' | 'vendor' | 'cost' | 'coveredAmount' | 'savedYou'
> & {
  warrantyId: string | null;
  incidentId: string | null;
  vendorId: string | null;
  cost: Money | null;
  coveredAmount: Money | null;
};

/** `overdue` and `person` are computed on read; the person is the registry's row. */
export type StoredLoan = Omit<Loan, 'overdue' | 'person'> & {
  locationId: string;
  personId: string;
  /** Who recorded it (a member receives their own loans' reminders by default, Q8). */
  createdById: string;
};

export type ScheduleSubject = { thingId: string } | { placeId: string };

export type StoredSchedule = Omit<Schedule, 'subject' | 'meter' | 'next' | 'lastService'> & {
  subject: ScheduleSubject;
  meterId: string | null;
};

export type StoredServiceRecord = Omit<ServiceRecord, 'subject' | 'total' | 'lines'> & {
  locationId: string;
  subject: ScheduleSubject;
  total: Money | null;
  lines: Array<{
    id: string;
    kind: ServiceRecord['lines'][number]['kind'];
    description: string;
    quantity: string | null;
    unitCost: Money | null;
  }>;
  loggedById: string;
};

/** `state` and `history` are computed on read; `subject` is what the create named. */
export type StoredDocument = Omit<ExpiringDocument, 'subject' | 'state' | 'history'> & {
  subject: SubjectInput;
  createdAt: string;
};

/** A notification for one user; a reminder's `state` and `actions` are read from its source. */
export type StoredNotification = Omit<Notification, 'reminder'> & {
  userId: string;
  reminder?: Omit<NonNullable<Notification['reminder']>, 'state' | 'actions'>;
};

export type StoredPreference = {
  locationId: string | null;
  kind: NotifyKind;
  channel: PreferenceChannel;
  enabled: boolean;
};

export type StoredIncident = Omit<Incident, 'things' | 'claims' | 'thingCount' | 'claimCount'> & {
  thingIds: string[];
};

export type StoredClaimPack = ClaimPack & {
  createdById: string;
  scope: { incidentId: string } | { locationId: string; thingIds: string[] };
};

export type HouseholdState = {
  /** Murdock, the service centre and the ladder went into the inventory (`ensureSeeded`). */
  seeded: boolean;
  seedPeople: Person[];
  seedVendors: Vendor[];
  seedThings: Array<Partial<StoredThing> & { id: string; name: string; template: string }>;
  fxRates: StoredFxRate[];
  valuations: StoredValuation[];
  warranties: StoredWarranty[];
  claims: StoredClaim[];
  /** Brand id → logo URL (PUT /brands/:id/logo). */
  brandLogos: Record<string, string>;
  loans: StoredLoan[];
  schedules: StoredSchedule[];
  serviceRecords: StoredServiceRecord[];
  documents: StoredDocument[];
  /** A step-4 file's text by file id (the lease's), for the paperwork library's search (T12). */
  fileText: Record<string, string>;
  notifications: StoredNotification[];
  settings: {
    digestTime: string;
    quietFrom: string | null;
    quietTo: string | null;
    smtpConfigured: boolean;
    push: { available: boolean; publicKey: string | null; reason?: 'no_https' | 'no_subject' };
    aiSummaryEmail: boolean;
  };
  /** Only the choices a person made; everything else is `defaultPreference()` (Q8). */
  preferences: StoredPreference[];
  channels: Channel[];
  calendarFeeds: CalendarFeed[];
  incidents: StoredIncident[];
  claimPacks: StoredClaimPack[];
};

// ----- ids and dates ----------------------------------------------------------------------------

/** Deterministic ids for the step-4 fixtures (the capture fixtures use …0000001xxxxx). */
const hid = (n: number) => `01926f00-0000-7000-8000-0000002${String(n).padStart(5, '0')}`;

export const HOUSEHOLD_IDS = {
  person: { murdock: hid(1) },
  vendor: { samsungService: hid(2) },
  thing: { ladder: hid(3) },
  warranty: { tvMaker: hid(10), tvStore: hid(11) },
  claim: { tvRepair: hid(20) },
  valuation: { tv: hid(25) },
  loan: { drill: hid(30), ladder: hid(31) },
  schedule: { boiler: hid(40) },
  serviceRecord: { boilerLast: hid(45) },
  document: { homeInsurance: hid(50), familyLease: hid(51), familyLeasePrevious: hid(52) },
  file: { familyLease: hid(55) },
  attachment: { familyLease: hid(56) },
  notification: {
    drillOverdue: hid(60),
    boilerDue: hid(61),
    insuranceExpiring: hid(62),
    tvWarranty: hid(63),
    memberAdded: hid(64),
    memberEnded: hid(65),
    aiCap: hid(66),
    aiSummary: hid(67),
    exportReady: hid(68),
  },
  channel: { email: hid(70), webpush: hid(71) },
  pushSubscription: { phone: hid(72) },
  calendarFeed: { first: hid(75) },
  claimPack: { home: hid(80) },
} as const;

const H = HOUSEHOLD_IDS;
const I = INV_IDS;

/** A calendar date in a time zone, YYYY-MM-DD ("today" is the location's, §7.13). */
export function localDate(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today in Cairo, where every fixture location is, shifted by `days`. */
const cairo = (days = 0) => localDate('Africa/Cairo', new Date(Date.now() + days * 86_400_000));
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const actor = (displayName: string): ActorRef => ({ displayName });

// ----- fixtures ---------------------------------------------------------------------------------

export function householdFixtures(meId: string): HouseholdState {
  const home = I.loc.home;
  const garage = I.loc.garage;
  const family = I.loc.family;
  const boilerAnchor = cairo(10 - 365);
  return {
    seeded: false,
    seedPeople: [
      {
        id: H.person.murdock,
        ownerAccountId: I.account.ibrahim,
        displayName: 'Murdock',
        userId: null,
        rowVersion: 1,
      },
    ],
    seedVendors: [
      {
        id: H.vendor.samsungService,
        ownerAccountId: I.account.ibrahim,
        name: 'Samsung Service Centre',
        kind: 'service_centre',
        address: null,
        phone: null,
        website: null,
        rowVersion: 1,
      },
    ],
    seedThings: [
      {
        id: H.thing.ladder,
        template: I.thing.drill,
        locationId: garage,
        name: 'Aluminium ladder, 3 m',
        shortCode: 'L4DD3R',
        placeId: I.place.toolWall,
        containerId: null,
        brand: null,
        model: null,
        custom: {},
        tags: [],
        belongsTo: { id: H.person.murdock, displayName: 'Murdock' },
      },
    ],
    fxRates: [
      {
        accountId: I.account.ibrahim,
        fromCcy: 'USD',
        toCcy: 'EGP',
        rate: '48.65',
        validFrom: cairo(-14),
        rowVersion: 1,
        updatedBy: actor('Ibrahim'),
        updatedAt: ago(14 * 24),
      },
    ],
    valuations: [
      {
        id: H.valuation.tv,
        thingId: I.thing.tv,
        amount: '21000',
        currency: 'EGP',
        valuedOn: cairo(-30),
        source: 'estimate',
        notes: null,
        documents: [],
        rowVersion: 1,
        createdBy: actor('Ibrahim'),
        createdAt: ago(30 * 24),
      },
    ],
    warranties: [
      {
        id: H.warranty.tvMaker,
        thingId: I.thing.tv,
        kind: 'manufacturer',
        provider: 'Samsung',
        startsOn: '2025-01-18',
        endsOn: null,
        termMonths: 24,
        lifetime: false,
        leadDays: 30,
        claimContact: null,
        registered: true,
        registrationDeadline: null,
        documents: [],
        rowVersion: 1,
        createdBy: actor('Ibrahim'),
      },
      {
        id: H.warranty.tvStore,
        thingId: I.thing.tv,
        kind: 'store',
        provider: 'B.TECH',
        startsOn: '2025-01-18',
        endsOn: null,
        termMonths: 36,
        lifetime: false,
        leadDays: 30,
        claimContact: '19966',
        registered: false,
        registrationDeadline: null,
        documents: [],
        rowVersion: 1,
        createdBy: actor('Bruce'),
      },
    ],
    claims: [
      {
        id: H.claim.tvRepair,
        thingId: I.thing.tv,
        warrantyId: H.warranty.tvMaker,
        incidentId: null,
        vendorId: H.vendor.samsungService,
        openedOn: cairo(-6),
        reference: 'SR-4471902',
        status: 'in_repair',
        cost: null,
        coveredAmount: null,
        notes: 'No picture after power cut; panel suspected.',
        closedOn: null,
        documents: [],
        rowVersion: 2,
      },
    ],
    brandLogos: {},
    loans: [
      {
        id: H.loan.drill,
        thingId: I.thing.drill,
        locationId: garage,
        direction: 'out',
        personId: H.person.murdock,
        startedAt: ago(16 * 24),
        dueOn: cairo(-2),
        returnedAt: null,
        quantity: '1',
        splitFromThingId: null,
        returnPlace: null,
        previousPlace: {
          type: 'place',
          id: I.place.toolWall,
          name: 'Tool wall',
          path: 'Garage › Tool wall',
        },
        notes: null,
        conditionOut: [],
        conditionIn: [],
        rowVersion: 1,
        createdBy: actor('Bruce'),
        createdById: 'u-bruce',
      },
      {
        id: H.loan.ladder,
        thingId: H.thing.ladder,
        locationId: garage,
        direction: 'in',
        personId: H.person.murdock,
        startedAt: ago(10 * 24),
        dueOn: cairo(20),
        returnedAt: null,
        quantity: '1',
        splitFromThingId: null,
        returnPlace: null,
        previousPlace: null,
        notes: 'For the balcony awning.',
        conditionOut: [],
        conditionIn: [],
        rowVersion: 1,
        createdBy: actor('Ibrahim'),
        createdById: meId,
      },
    ],
    schedules: [
      {
        id: H.schedule.boiler,
        locationId: home,
        subject: { placeId: I.place.kitchen },
        meterId: null,
        name: 'Boiler service',
        everyMonths: 12,
        everyUnits: null,
        dueOn: null,
        leadDays: 14,
        leadUnits: null,
        anchorOn: boilerAnchor,
        anchorValue: null,
        snoozedUntil: null,
        snoozedUntilValue: null,
        skipNext: false,
        active: true,
        rowVersion: 1,
      },
    ],
    serviceRecords: [
      {
        id: H.serviceRecord.boilerLast,
        locationId: home,
        subject: { placeId: I.place.kitchen },
        servicedOn: boilerAnchor,
        reading: null,
        vendor: null,
        total: { amount: '850', currency: 'EGP' },
        lines: [],
        completes: [{ scheduleId: H.schedule.boiler, name: 'Boiler service' }],
        notes: null,
        invoices: [],
        loggedBy: actor('Ibrahim'),
        loggedById: meId,
        rowVersion: 1,
      },
    ],
    documents: [
      {
        id: H.document.homeInsurance,
        locationId: home,
        subject: { locationId: home },
        kind: 'insurance',
        title: 'Home insurance',
        expiresOn: cairo(20),
        leadDays: 30,
        supersededById: null,
        documents: [],
        rowVersion: 1,
        createdAt: ago(340 * 24),
      },
      {
        id: H.document.familyLeasePrevious,
        locationId: family,
        subject: { locationId: family },
        kind: 'lease',
        title: 'عقد الإيجار',
        expiresOn: cairo(-165),
        leadDays: 30,
        supersededById: H.document.familyLease,
        documents: [],
        rowVersion: 2,
        createdAt: ago(530 * 24),
      },
      {
        id: H.document.familyLease,
        locationId: family,
        subject: { locationId: family },
        kind: 'lease',
        title: 'عقد الإيجار',
        expiresOn: cairo(200),
        leadDays: 30,
        supersededById: null,
        documents: [
          {
            id: H.attachment.familyLease,
            role: 'document',
            sort: 0,
            file: {
              id: H.file.familyLease,
              sha256: 'b1c4a5e0d2f7b9a3c6e8d0f2a4b6c8e0d2f4a6b8c0e2d4f6a8b0c2e4d6f8a0b2',
              bytes: 184_220,
              mime: 'application/pdf',
              class: 'document',
              hasGps: false,
              width: null,
              height: null,
              derivativeState: 'not_applicable',
              thumbUrl: null,
              displayUrl: null,
            },
            url: null,
            subject: { location: true },
            createdBy: actor('ألفريد'),
            rowVersion: 1,
          },
        ],
        rowVersion: 1,
        createdAt: ago(165 * 24),
      },
    ],
    fileText: {
      [H.file.familyLease]:
        'عقد إيجار شقة سكنية. المؤجر: بروس. المستأجر: ألفريد. مدة العقد سنة ميلادية تبدأ من تاريخ التوقيع، والإيجار الشهري يُدفع مقدماً في أول كل شهر.',
    },
    notifications: [
      {
        id: H.notification.drillOverdue,
        userId: meId,
        kind: 'reminder',
        createdAt: ago(20),
        readAt: null,
        locationId: garage,
        reminder: {
          occurrenceId: hid(90),
          sourceType: 'loan',
          sourceId: H.loan.drill,
          kind: 'overdue',
          dueOn: cairo(-2),
          dueValue: null,
          subject: {
            type: 'thing',
            id: I.thing.drill,
            name: 'Bosch drill, 18 V',
            path: 'Garage › Tool wall',
            shortCode: '2HX9RB',
          },
          title: 'Bosch drill, 18 V',
        },
      },
      {
        id: H.notification.boilerDue,
        userId: meId,
        kind: 'reminder',
        createdAt: ago(5),
        readAt: null,
        locationId: home,
        reminder: {
          occurrenceId: hid(91),
          sourceType: 'schedule',
          sourceId: H.schedule.boiler,
          kind: 'due',
          dueOn: cairo(10),
          dueValue: null,
          subject: { type: 'place', id: I.place.kitchen, name: 'Kitchen', path: 'Home › Kitchen' },
          title: 'Boiler service',
        },
      },
      {
        id: H.notification.insuranceExpiring,
        userId: meId,
        kind: 'reminder',
        createdAt: ago(30),
        readAt: null,
        locationId: home,
        reminder: {
          occurrenceId: hid(92),
          sourceType: 'document',
          sourceId: H.document.homeInsurance,
          kind: 'expiring',
          dueOn: cairo(20),
          dueValue: null,
          subject: { type: 'location', id: home, name: 'Home', path: '' },
          title: 'Home insurance',
        },
      },
      {
        id: H.notification.tvWarranty,
        userId: meId,
        kind: 'reminder',
        createdAt: ago(24 * 9),
        readAt: ago(24 * 8),
        locationId: home,
        reminder: {
          occurrenceId: hid(93),
          sourceType: 'warranty',
          sourceId: H.warranty.tvMaker,
          kind: 'expiring',
          dueOn: '2027-01-17',
          dueValue: null,
          subject: {
            type: 'thing',
            id: I.thing.tv,
            name: 'Samsung TV, 55″',
            path: 'Home › Living room',
            shortCode: '5MT0QD',
          },
          title: 'Samsung',
        },
      },
      {
        id: H.notification.memberAdded,
        userId: meId,
        kind: 'membership_added',
        createdAt: ago(26),
        readAt: null,
        locationId: home,
        membership: { userName: 'Louis', role: 'member', locationName: 'Home' },
      },
      {
        id: H.notification.memberEnded,
        userId: meId,
        kind: 'membership_ended',
        createdAt: ago(24 * 12),
        readAt: ago(24 * 11),
        locationId: garage,
        membership: { userName: 'Talia', role: 'viewer', locationName: 'Garage' },
      },
      {
        id: H.notification.aiCap,
        userId: meId,
        kind: 'ai_cap',
        createdAt: ago(24 * 3),
        readAt: ago(24 * 2),
        locationId: home,
        aiCap: { scope: 'location', level: 80, month: cairo().slice(0, 7) },
      },
      {
        id: H.notification.aiSummary,
        userId: meId,
        kind: 'ai_summary',
        createdAt: ago(24 * 29),
        readAt: ago(24 * 28),
        locationId: null,
      },
      {
        id: H.notification.exportReady,
        userId: meId,
        kind: 'export_ready',
        createdAt: ago(48),
        readAt: ago(47),
        locationId: home,
        exportReady: { runId: H.claimPack.home, kind: 'claim_pack' },
      },
    ],
    settings: {
      digestTime: '08:00',
      quietFrom: null,
      quietTo: null,
      smtpConfigured: true,
      // A well-formed but made-up P-256 public key (65 bytes, unpadded base64url), so
      // `pushManager.subscribe()` accepts it in the demo; no push service knows it.
      push: {
        available: true,
        publicKey:
          'BAswVXqfxOkOM1h9osfsETZbgKXK7xQ5XoOozfIXPGGGq9D1Gj9kia7T-B1CZ4yx1vsgRWqPtNn-I0htkrfcASY',
      },
      aiSummaryEmail: true,
    },
    preferences: [],
    channels: [
      {
        id: H.channel.email,
        kind: 'email',
        label: null,
        displayHost: null,
        verifiedAt: ago(24 * 60),
        failingSince: null,
      },
      {
        id: H.channel.webpush,
        kind: 'webpush',
        label: null,
        displayHost: null,
        verifiedAt: ago(24 * 20),
        failingSince: null,
        subscriptions: [
          {
            id: H.pushSubscription.phone,
            label: 'iPhone',
            createdAt: ago(24 * 20),
            lastSuccessAt: ago(20),
          },
        ],
      },
    ],
    calendarFeeds: [
      {
        id: H.calendarFeed.first,
        createdAt: ago(24 * 40),
        lastFetchedAt: ago(2),
        fetches: 612,
        revokedAt: null,
      },
    ],
    incidents: [],
    claimPacks: [
      {
        id: H.claimPack.home,
        createdById: meId,
        scope: { locationId: home, thingIds: [I.thing.tv] },
        status: 'done',
        progress: { done: 3, total: 3 },
        bytes: 1_842_311,
        link: {
          expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          downloads: 1,
          lastDownloadedAt: ago(30),
        },
        expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
    ],
  };
}
