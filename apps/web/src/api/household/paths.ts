/**
 * Every step-4 server path the web app calls, in one place. Each comes from the route tables of
 * the step-4 plan's Phase B (tasks 8–18) and lands in the matching
 * `apps/server/src/<area>/routes.ts` (task 2's stubs). A path the server names differently is
 * fixed here and nowhere else. Task 30's contract check reads `HOUSEHOLD_METHODS` against the
 * server's openapi.json, as steps 2 and 3 do with `METHODS` and `CAPTURE_METHODS`.
 *
 * Paths that already exist are not repeated: uploads and attachments (`inventoryPaths.file`,
 * `inventoryPaths.attachments`, which gain the `warranty`, `claim`, `loan`, `service_record` and
 * `document` subjects in T9–T12), a finished report (`inventoryPaths.report`, now for either
 * kind), and the undo route (`inventoryPaths.undo`). The public `GET /cal/:token.ics` and
 * `GET /x/:token` are URLs the server hands out, never fetched by the app.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const householdPaths = {
  // ----- money: exchange rates and valuations (T8) -----
  fxRates: (accountId: string) => `${V1}/accounts/${seg(accountId)}/fx-rates`,
  fxRate: (accountId: string, from: string, to: string, validFrom: string) =>
    `${V1}/accounts/${seg(accountId)}/fx-rates/${seg(from)}/${seg(to)}/${seg(validFrom)}`,
  thingValuations: (id: string) => `${V1}/things/${seg(id)}/valuations`,
  valuation: (id: string) => `${V1}/valuations/${seg(id)}`,

  // ----- warranties, claims and brand logos (T9) -----
  thingWarranties: (id: string) => `${V1}/things/${seg(id)}/warranties`,
  thingWarrantyDefaults: (id: string) => `${V1}/things/${seg(id)}/warranty-defaults`,
  warranty: (id: string) => `${V1}/warranties/${seg(id)}`,
  thingClaims: (id: string) => `${V1}/things/${seg(id)}/claims`,
  thingClaimPrefill: (id: string) => `${V1}/things/${seg(id)}/claim-prefill`,
  claim: (id: string) => `${V1}/claims/${seg(id)}`,
  brandLogo: (id: string) => `${V1}/brands/${seg(id)}/logo`,

  // ----- lending and borrowing (T10) -----
  thingLend: (id: string) => `${V1}/things/${seg(id)}/lend`,
  locationBorrow: (id: string) => `${V1}/locations/${seg(id)}/borrow`,
  loans: `${V1}/loans`,
  loan: (id: string) => `${V1}/loans/${seg(id)}`,
  loanReturn: (id: string) => `${V1}/loans/${seg(id)}/return`,
  loanAttachments: (id: string) => `${V1}/loans/${seg(id)}/attachments`,
  thingLoans: (id: string) => `${V1}/things/${seg(id)}/loans`,
  personLoans: (id: string) => `${V1}/people/${seg(id)}/loans`,

  // ----- schedules and service records (T11) -----
  schedules: `${V1}/schedules`,
  schedule: (id: string) => `${V1}/schedules/${seg(id)}`,
  scheduleComplete: (id: string) => `${V1}/schedules/${seg(id)}/complete`,
  scheduleSnooze: (id: string) => `${V1}/schedules/${seg(id)}/snooze`,
  scheduleSkip: (id: string) => `${V1}/schedules/${seg(id)}/skip`,
  scheduleUnsnooze: (id: string) => `${V1}/schedules/${seg(id)}/unsnooze`,
  thingSchedules: (id: string) => `${V1}/things/${seg(id)}/schedules`,
  placeSchedules: (id: string) => `${V1}/places/${seg(id)}/schedules`,
  serviceRecords: `${V1}/service-records`,
  serviceRecord: (id: string) => `${V1}/service-records/${seg(id)}`,
  thingServiceRecords: (id: string) => `${V1}/things/${seg(id)}/service-records`,
  placeServiceRecords: (id: string) => `${V1}/places/${seg(id)}/service-records`,

  // ----- the paperwork library and expiring documents (T12) -----
  paperwork: `${V1}/paperwork`,
  documents: `${V1}/documents`,
  document: (id: string) => `${V1}/documents/${seg(id)}`,
  documentRenew: (id: string) => `${V1}/documents/${seg(id)}/renew`,

  // ----- the agenda (T13) -----
  agenda: `${V1}/agenda`,

  // ----- channels and preferences (T15) -----
  notificationSettings: `${V1}/me/notification-settings`,
  notificationPreferences: `${V1}/me/notification-preferences`,
  channels: `${V1}/me/channels`,
  channel: (id: string) => `${V1}/me/channels/${seg(id)}`,
  channelTest: (id: string) => `${V1}/me/channels/${seg(id)}/test`,
  pushSubscriptions: `${V1}/me/push-subscriptions`,
  pushSubscription: (id: string) => `${V1}/me/push-subscriptions/${seg(id)}`,
  pushSubscriptionTest: (id: string) => `${V1}/me/push-subscriptions/${seg(id)}/test`,

  // ----- the notification centre (T16) -----
  notifications: `${V1}/notifications`,
  notificationsCount: `${V1}/notifications/count`,
  notificationsRead: `${V1}/notifications/read`,

  // ----- the calendar feed (T17) -----
  calendarFeeds: `${V1}/me/calendar-feeds`,
  calendarFeed: (id: string) => `${V1}/me/calendar-feeds/${seg(id)}`,

  // ----- incidents, the insurance report and claim packs (T18) -----
  incidents: `${V1}/incidents`,
  incident: (id: string) => `${V1}/incidents/${seg(id)}`,
  incidentThings: (id: string) => `${V1}/incidents/${seg(id)}/things`,
  locationIncidents: (id: string) => `${V1}/locations/${seg(id)}/incidents`,
  reportsInsurance: `${V1}/reports/insurance`,
  reportsInsuranceCsv: `${V1}/reports/insurance.csv`,
  claimPacks: `${V1}/claim-packs`,
  claimPack: (id: string) => `${V1}/claim-packs/${seg(id)}`,
  claimPackLink: (id: string) => `${V1}/claim-packs/${seg(id)}/link`,
} as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The methods the web app uses on each path (the contract check, task 30). */
export const HOUSEHOLD_METHODS: Record<keyof typeof householdPaths, readonly Method[]> = {
  fxRates: ['GET', 'PUT'],
  fxRate: ['DELETE'],
  thingValuations: ['GET', 'POST'],
  valuation: ['PATCH', 'DELETE'],
  thingWarranties: ['GET', 'POST'],
  thingWarrantyDefaults: ['GET'],
  warranty: ['PATCH', 'DELETE'],
  thingClaims: ['GET', 'POST'],
  thingClaimPrefill: ['GET'],
  claim: ['PATCH', 'DELETE'],
  brandLogo: ['PUT', 'DELETE'],
  thingLend: ['POST'],
  locationBorrow: ['POST'],
  loans: ['GET'],
  loan: ['PATCH', 'DELETE'],
  loanReturn: ['POST'],
  loanAttachments: ['POST'],
  thingLoans: ['GET'],
  personLoans: ['GET'],
  schedules: ['GET', 'POST'],
  schedule: ['PATCH', 'DELETE'],
  scheduleComplete: ['POST'],
  scheduleSnooze: ['POST'],
  scheduleSkip: ['POST'],
  scheduleUnsnooze: ['POST'],
  thingSchedules: ['GET'],
  placeSchedules: ['GET'],
  serviceRecords: ['POST'],
  serviceRecord: ['PATCH', 'DELETE'],
  thingServiceRecords: ['GET'],
  placeServiceRecords: ['GET'],
  paperwork: ['GET'],
  documents: ['GET', 'POST'],
  document: ['GET', 'PATCH', 'DELETE'],
  documentRenew: ['POST'],
  agenda: ['GET'],
  notificationSettings: ['GET', 'PUT'],
  notificationPreferences: ['PUT'],
  channels: ['POST'],
  channel: ['DELETE'],
  channelTest: ['POST'],
  pushSubscriptions: ['POST'],
  pushSubscription: ['DELETE'],
  pushSubscriptionTest: ['POST'],
  notifications: ['GET'],
  notificationsCount: ['GET'],
  notificationsRead: ['POST'],
  calendarFeeds: ['GET', 'POST'],
  calendarFeed: ['DELETE'],
  incidents: ['GET'],
  incident: ['GET', 'PATCH', 'DELETE'],
  incidentThings: ['POST'],
  locationIncidents: ['POST'],
  reportsInsurance: ['POST'],
  reportsInsuranceCsv: ['GET'],
  claimPacks: ['POST'],
  claimPack: ['GET'],
  claimPackLink: ['POST', 'DELETE'],
};
