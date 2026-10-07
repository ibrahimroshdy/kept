/**
 * Every step-2 server path the web app calls (plan Phase B, tasks 11–22), in one place. Task 30's
 * contract check loads the server's /api/v1/openapi.json and asserts every path here exists with
 * its method, so a path is fixed here and nowhere else.
 *
 * `METHODS` lists the method(s) the web uses for each entry; the contract check reads it.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export type RegistryPathKind = 'brands' | 'vendors' | 'people' | 'tags';

export const inventoryPaths = {
  // ----- accounts, types, place kinds, registries (task 11) -----
  accounts: `${V1}/accounts`,
  accountTypes: (accountId: string) => `${V1}/accounts/${seg(accountId)}/types`,
  type: (id: string) => `${V1}/types/${seg(id)}`,
  typePreview: (id: string) => `${V1}/types/${seg(id)}/preview`,
  typeFields: (id: string) => `${V1}/types/${seg(id)}/fields`,
  typeCustomise: (id: string) => `${V1}/types/${seg(id)}/customise`,
  typeMergeInto: (id: string) => `${V1}/types/${seg(id)}/merge-into`,
  typeField: (id: string) => `${V1}/type-fields/${seg(id)}`,
  typeFieldArchive: (id: string) => `${V1}/type-fields/${seg(id)}/archive`,
  typeFieldRestore: (id: string) => `${V1}/type-fields/${seg(id)}/restore`,
  accountPlaceKinds: (accountId: string) => `${V1}/accounts/${seg(accountId)}/place-kinds`,
  placeKind: (id: string) => `${V1}/place-kinds/${seg(id)}`,
  placeKindFields: (id: string) => `${V1}/place-kinds/${seg(id)}/fields`,
  placeKindCustomise: (accountId: string, builtinKey: string) =>
    `${V1}/accounts/${seg(accountId)}/place-kinds/${seg(builtinKey)}/customise`,
  accountRegistry: (accountId: string, kind: RegistryPathKind) =>
    `${V1}/accounts/${seg(accountId)}/${kind}`,
  registryItem: (kind: RegistryPathKind, id: string) => `${V1}/${kind}/${seg(id)}`,
  registryMergeInto: (kind: RegistryPathKind, id: string) => `${V1}/${kind}/${seg(id)}/merge-into`,
  personContact: (id: string) => `${V1}/people/${seg(id)}/contact`,

  // ----- currencies and purchases (task 12) -----
  currencies: `${V1}/currencies`,
  adminCurrency: (code: string) => `${V1}/admin/currencies/${seg(code)}`,
  purchases: `${V1}/purchases`,
  purchase: (id: string) => `${V1}/purchases/${seg(id)}`,
  purchaseLineLink: (id: string) => `${V1}/purchase-lines/${seg(id)}/link`,

  // ----- places (task 13) -----
  locationPlaces: (locationId: string) => `${V1}/locations/${seg(locationId)}/places`,
  place: (id: string) => `${V1}/places/${seg(id)}`,
  placeContents: (id: string) => `${V1}/places/${seg(id)}/contents`,
  placeTrash: (id: string) => `${V1}/places/${seg(id)}/trash`,
  placeRestore: (id: string) => `${V1}/places/${seg(id)}/restore`,
  placeMergeInto: (id: string) => `${V1}/places/${seg(id)}/merge-into`,
  placeConvertToContainer: (id: string) => `${V1}/places/${seg(id)}/convert-to-container`,
  placeLabel: (id: string) => `${V1}/places/${seg(id)}/label`,
  placeHistory: (id: string) => `${V1}/places/${seg(id)}/history`,
  placeAttachments: (id: string) => `${V1}/places/${seg(id)}/attachments`,
  placeSecret: (id: string, fieldKey: string) => `${V1}/places/${seg(id)}/secrets/${seg(fieldKey)}`,
  placeSecretReveal: (id: string, fieldKey: string) =>
    `${V1}/places/${seg(id)}/secrets/${seg(fieldKey)}/reveal`,
  placeSecretCopied: (id: string, fieldKey: string) =>
    `${V1}/places/${seg(id)}/secrets/${seg(fieldKey)}/copied`,

  // ----- things (task 14) -----
  things: `${V1}/things`,
  thing: (id: string) => `${V1}/things/${seg(id)}`,
  thingLifecycle: (id: string) => `${V1}/things/${seg(id)}/lifecycle`,
  thingSeen: (id: string) => `${V1}/things/${seg(id)}/seen`,
  thingNotHere: (id: string) => `${V1}/things/${seg(id)}/not-here`,
  thingRetype: (id: string) => `${V1}/things/${seg(id)}/retype`,
  thingDuplicate: (id: string) => `${V1}/things/${seg(id)}/duplicate`,
  thingSplit: (id: string) => `${V1}/things/${seg(id)}/split`,
  thingLinks: (id: string) => `${V1}/things/${seg(id)}/links`,
  thingLink: (linkId: string) => `${V1}/thing-links/${seg(linkId)}`,
  thingConvertToPlace: (id: string) => `${V1}/things/${seg(id)}/convert-to-place`,
  code: (code: string) => `${V1}/codes/${seg(code)}`,

  // ----- moves (task 15) -----
  movePreview: `${V1}/things/move/preview`,
  move: `${V1}/things/move`,
  thingEmptyInto: (id: string) => `${V1}/things/${seg(id)}/empty-into`,

  // ----- meters and readings (task 16) -----
  thingMeters: (id: string) => `${V1}/things/${seg(id)}/meters`,
  meter: (id: string) => `${V1}/meters/${seg(id)}`,
  meterReadings: (id: string) => `${V1}/meters/${seg(id)}/readings`,
  meterReplaced: (id: string) => `${V1}/meters/${seg(id)}/replaced`,
  reading: (id: string) => `${V1}/readings/${seg(id)}`,
  readingAccept: (id: string) => `${V1}/readings/${seg(id)}/accept`,

  // ----- files and attachments (task 17) -----
  /** PUT, raw body, `?locationId=&class=`, headers Content-Length and X-Kept-Sha256. */
  file: (fileId: string) => `${V1}/files/${seg(fileId)}`,
  fileUrl: (fileId: string) => `${V1}/files/${seg(fileId)}/url`,
  attachments: `${V1}/attachments`,
  attachment: (id: string) => `${V1}/attachments/${seg(id)}`,
  thingAttachments: (id: string) => `${V1}/things/${seg(id)}/attachments`,
  purchaseAttachments: (id: string) => `${V1}/purchases/${seg(id)}/attachments`,
  locationAttachments: (id: string) => `${V1}/locations/${seg(id)}/attachments`,

  // ----- secrets (task 19) -----
  thingSecret: (id: string, fieldKey: string) => `${V1}/things/${seg(id)}/secrets/${seg(fieldKey)}`,
  thingSecretReveal: (id: string, fieldKey: string) =>
    `${V1}/things/${seg(id)}/secrets/${seg(fieldKey)}/reveal`,
  thingSecretCopied: (id: string, fieldKey: string) =>
    `${V1}/things/${seg(id)}/secrets/${seg(fieldKey)}/copied`,
  secretPolicy: (locationId: string, typeFieldId: string) =>
    `${V1}/locations/${seg(locationId)}/secret-policies/${seg(typeFieldId)}`,

  // ----- search and saved views (task 20) -----
  search: `${V1}/search`,
  savedViews: `${V1}/saved-views`,
  savedView: (id: string) => `${V1}/saved-views/${seg(id)}`,
  /** Your default and pinned views on one list (D205). */
  savedViewPrefs: (surface: string) => `${V1}/saved-views/prefs/${seg(surface)}`,

  // ----- trash, history, activity (task 21) -----
  thingTrash: (id: string) => `${V1}/things/${seg(id)}/trash`,
  thingRestore: (id: string) => `${V1}/things/${seg(id)}/restore`,
  trash: `${V1}/trash`,
  thingHistory: (id: string) => `${V1}/things/${seg(id)}/history`,
  activity: `${V1}/activity`,
  locationActors: (id: string) => `${V1}/locations/${seg(id)}/actors`,
  undo: (eventId: string) => `${V1}/audit/${seg(eventId)}/undo`,

  // ----- home and hints (task 22) -----
  home: `${V1}/home`,
  hints: `${V1}/me/hints`,
  hint: (key: string) => `${V1}/me/hints/${seg(key)}`,

  // ----- the inventory report (task 32, D201; apps/server/src/reports/routes.ts) -----
  /** POST `{scope, filters?, include?, locale?, digits?}` → 202 `{id, status, expiresAt}`. */
  reportsInventory: `${V1}/reports/inventory`,
  /** GET: the run's status, progress and, once done, a five-minute `fileUrl`. */
  report: (id: string) => `${V1}/reports/${seg(id)}`,
} as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * The methods the web app uses on each path (the contract check, task 30). Registry paths are
 * listed per kind by the check itself.
 */
export const METHODS: Record<keyof typeof inventoryPaths, readonly Method[]> = {
  accounts: ['GET'],
  accountTypes: ['GET', 'POST'],
  type: ['GET', 'PATCH', 'DELETE'],
  typePreview: ['POST'],
  typeFields: ['POST'],
  typeCustomise: ['POST'],
  typeMergeInto: ['POST'],
  typeField: ['PATCH'],
  typeFieldArchive: ['POST'],
  typeFieldRestore: ['POST'],
  accountPlaceKinds: ['GET', 'POST'],
  placeKind: ['PATCH'],
  placeKindFields: ['POST'],
  placeKindCustomise: ['POST'],
  accountRegistry: ['GET', 'POST'],
  registryItem: ['GET', 'PATCH', 'DELETE'],
  registryMergeInto: ['POST'],
  personContact: ['GET', 'PUT'],
  currencies: ['GET'],
  adminCurrency: ['PATCH'],
  purchases: ['POST'],
  purchase: ['GET', 'PATCH', 'DELETE'],
  purchaseLineLink: ['POST', 'DELETE'],
  locationPlaces: ['GET', 'POST'],
  place: ['GET', 'PATCH', 'DELETE'],
  placeContents: ['GET'],
  placeTrash: ['POST'],
  placeRestore: ['POST'],
  placeMergeInto: ['POST'],
  placeConvertToContainer: ['POST'],
  placeLabel: ['POST'],
  placeHistory: ['GET'],
  placeAttachments: ['GET'],
  placeSecret: ['PUT', 'DELETE'],
  placeSecretReveal: ['POST'],
  placeSecretCopied: ['POST'],
  things: ['GET', 'POST'],
  thing: ['GET', 'PATCH', 'DELETE'],
  thingLifecycle: ['POST'],
  thingSeen: ['POST'],
  thingNotHere: ['POST'],
  thingRetype: ['POST'],
  thingDuplicate: ['POST'],
  thingSplit: ['POST'],
  thingLinks: ['POST'],
  thingLink: ['DELETE'],
  thingConvertToPlace: ['POST'],
  code: ['GET'],
  movePreview: ['POST'],
  move: ['POST'],
  thingEmptyInto: ['POST'],
  thingMeters: ['POST'],
  meter: ['PATCH'],
  meterReadings: ['GET', 'POST'],
  meterReplaced: ['POST'],
  reading: ['PATCH', 'DELETE'],
  readingAccept: ['POST'],
  file: ['PUT', 'DELETE'],
  fileUrl: ['POST'],
  attachments: ['POST'],
  attachment: ['PATCH', 'DELETE'],
  thingAttachments: ['GET'],
  purchaseAttachments: ['GET'],
  locationAttachments: ['GET'],
  thingSecret: ['PUT', 'DELETE'],
  thingSecretReveal: ['POST'],
  thingSecretCopied: ['POST'],
  secretPolicy: ['GET', 'PUT'],
  search: ['GET'],
  savedViews: ['GET', 'POST'],
  savedView: ['PATCH', 'DELETE'],
  savedViewPrefs: ['PUT'],
  thingTrash: ['POST'],
  thingRestore: ['POST'],
  trash: ['GET'],
  thingHistory: ['GET'],
  activity: ['GET'],
  locationActors: ['GET'],
  undo: ['POST'],
  home: ['GET'],
  hints: ['GET'],
  hint: ['PUT'],
  reportsInventory: ['POST'],
  report: ['GET'],
};

/**
 * A query string from defined, non-empty values only (`?q=cab&limit=20`), or ''. An array repeats
 * its key (`?typeId=a&typeId=b&not=typeId`, the list filters of D205); an empty one is left out.
 */
export function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
