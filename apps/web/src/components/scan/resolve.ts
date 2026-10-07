/**
 * What a scan means (D137's six outcomes, engineering spec §2.4; plan T26). Every way in (the
 * scanner, "Type the code", a `/l/<code>` link, the box check's "Found something else") reads
 * through `resolveScan`:
 *
 * 1. `parseScan` classifies the text; the host of a Kept link is ignored (D120).
 * 2. **The phone first.** Each `LocalResolver` looks in the offline store in turn; the first
 *    answer wins. This is how a scan works offline, and it is instant online. The list is open:
 *    own codes and CSV old codes (D208, plan T17a) are one more resolver, `ownCodeResolver`,
 *    which reads the text as typed.
 * 3. **Then the server**, when online: `POST /scan/resolve`. `not_in_your_kept` is the same
 *    answer for a missing, forbidden or retired code, and another household's blank.
 * 4. **Offline and not on the phone:** a Kept or Homebox code is "Not on this phone" (the sixth
 *    outcome), and the caller queues it as a notice to re-check online; a product barcode is
 *    "Add as a new thing" without a lookup; anything else is "Not a Kept label".
 *
 * Opening never marks anything seen here: the caller does, after opening (`markSeen`, D40).
 */
import {
  can,
  newId,
  parseScan,
  type QueueItem,
  type Role,
  type ScanResult,
  storedCodeOf,
} from '@kept/shared';
import type { QueryClient } from '@tanstack/react-query';
import { captureApi } from '@/api/capture/queries';
import type { ScanOutcome, ScanResolveBody } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import type { LegacyHit, OfflineStore, SyncNotice } from '@/offline/store';
import type { SyncStore } from '@/offline/sync-store';

export type ScanTarget = { kind: 'thing' | 'place'; id: string; locationId: string };
export type LegacyCandidate = {
  kind: 'thing' | 'place';
  id: string;
  name: string;
  locationName: string;
  /** Carried by the phone's answers and the server's alike (T17). */
  locationId?: string;
};

/** Where an answer came from: the phone's snapshot, or the server. */
export type Source = 'phone' | 'server';

export type Resolution =
  | {
      outcome: 'open';
      target: ScanTarget;
      /** The Kept code read, when it was one. */
      code: string | null;
      /** An old label (Homebox, or an own code later), shown as it reads: "Asset 000-014". */
      legacy: string | null;
      from: Source;
    }
  | { outcome: 'claim'; code: string; locationId: string; from: Source }
  | { outcome: 'not_in_your_kept'; code: string | null }
  | { outcome: 'legacy_ambiguous'; legacy: string; candidates: LegacyCandidate[] }
  /** `lookupEnabled` is null offline: the lookup can't run, so it isn't known. */
  | { outcome: 'barcode'; code: string; lookupEnabled: boolean | null }
  | { outcome: 'not_kept'; text: string }
  | { outcome: 'not_on_phone'; text: string; code: string | null };

export type Read = { text: string; format?: string };

/** The phone's store as the scanner uses it; `addNotice` where the store has one (Dexie). */
export type ScanStore = OfflineStore & Partial<Pick<SyncStore, 'addNotice' | 'dismissNotice'>>;

/** One way to answer a scan from the phone; null when it isn't this resolver's kind of code.
 * `text` is what was read, as read (a resolver that looks codes up as typed needs it). */
export type LocalResolver = (
  scan: ScanResult,
  store: OfflineStore,
  text: string,
) => Promise<Resolution | null>;

/** A Kept short ID: a thing, a place, or a blank label in the snapshot's codes (D120). */
export const keptCodeResolver: LocalResolver = async (scan, store) => {
  if (scan.kind !== 'kept') return null;
  const hit = await store.byCode(scan.code);
  if (!hit) return null;
  if (hit.kind === 'blank') {
    const loc = (await store.locations()).find((l) => l.id === hit.locationId);
    // A blank you can see but not write to answers as the server does: not yours to claim.
    if (!loc || !can(loc.role, 'labels.use'))
      return { outcome: 'not_in_your_kept', code: scan.code };
    return { outcome: 'claim', code: scan.code, locationId: hit.locationId, from: 'phone' };
  }
  if (!hit.id) return null;
  return {
    outcome: 'open',
    target: { kind: hit.kind, id: hit.id, locationId: hit.locationId },
    code: scan.code,
    legacy: null,
    from: 'phone',
  };
};

/** "Asset 000-014" for an asset label; the UUID for an item or location link. */
export function legacyLabel(scan: Extract<ScanResult, { kind: 'homebox' }>): string {
  return scan.assetId ?? scan.uuid ?? '';
}

/**
 * An old Homebox label (D146), through the snapshot's legacy codes. The asset ID is looked up as
 * Homebox prints it (`000-014`); an item or location link by its UUID (inferred: the import, T18
 * and step 7, decides which Homebox value it stores as the code).
 */
export const homeboxResolver: LocalResolver = async (scan, store) => {
  if (scan.kind !== 'homebox') return null;
  const code = legacyLabel(scan);
  if (!code) return null;
  const hits = await store.byLegacy('homebox', code);
  if (hits.length === 0) return null;
  return fromLegacyHits(store, hits, code);
};

/** The live targets of legacy-code hits: one opens, several ask which (D146). */
async function fromLegacyHits(
  store: OfflineStore,
  hits: readonly LegacyHit[],
  code: string,
): Promise<Resolution | null> {
  const locations = await store.locations();
  const candidates: LegacyCandidate[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = h.thingId ?? h.placeId ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    const locationName = locations.find((l) => l.id === h.locationId)?.name ?? '';
    if (h.thingId) {
      const t = await store.thing(h.thingId);
      if (t)
        candidates.push({
          kind: 'thing',
          id: t.id,
          name: t.name ?? '',
          locationName,
          locationId: h.locationId,
        });
    } else if (h.placeId) {
      const p = (await store.placesOf(h.locationId)).find((x) => x.id === h.placeId);
      if (p)
        candidates.push({
          kind: 'place',
          id: p.id,
          name: p.name,
          locationName,
          locationId: h.locationId,
        });
    }
  }
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return {
      outcome: 'open',
      target: { kind: only.kind, id: only.id, locationId: only.locationId ?? '' },
      code: null,
      legacy: code,
      from: 'phone',
    };
  }
  if (candidates.length > 1) return { outcome: 'legacy_ambiguous', legacy: code, candidates };
  return null;
}

/**
 * The household's own codes and a CSV import's old codes (D208, T18), and a Homebox asset ID
 * typed by hand, looked up as typed (upper case, Eastern digits folded: `storedCodeOf`), whatever
 * kind the text parsed as, after the short IDs: the server's order (scan/resolve.ts `anyLegacy`).
 */
export const ownCodeResolver: LocalResolver = async (scan, store, text) => {
  if (scan.kind === 'homebox') return null;
  const code = storedCodeOf(text);
  if (!code || code.length > 100) return null;
  const hits: LegacyHit[] = [];
  for (const source of ['own', 'csv', 'homebox'] as const)
    hits.push(...(await store.byLegacy(source, code)));
  if (hits.length === 0) return null;
  return fromLegacyHits(store, hits, code);
};

/** The phone's resolvers, in order: short IDs, Homebox labels, then codes as typed. */
export const LOCAL_RESOLVERS: readonly LocalResolver[] = [
  keptCodeResolver,
  homeboxResolver,
  ownCodeResolver,
];

export type ResolveDeps = {
  store: OfflineStore | null;
  online: boolean;
  server?: (body: ScanResolveBody) => Promise<ScanOutcome>;
  resolvers?: readonly LocalResolver[];
};

const isOffline = (e: unknown) => isApiError(e) && e.code === 'offline';

/** The server's answer in the phone's terms. */
export function fromServer(scan: ScanResult, o: ScanOutcome): Resolution {
  const code = scan.kind === 'kept' ? scan.code : null;
  const legacy = scan.kind === 'homebox' ? legacyLabel(scan) : null;
  switch (o.outcome) {
    case 'open':
      return { outcome: 'open', target: o.target, code, legacy, from: 'server' };
    case 'claim':
      return { outcome: 'claim', code: code ?? '', locationId: o.locationId, from: 'server' };
    case 'not_in_your_kept':
      return { outcome: 'not_in_your_kept', code };
    case 'legacy_ambiguous':
      return {
        outcome: 'legacy_ambiguous',
        legacy: legacy ?? '',
        candidates: o.candidates.map((c) => ({ ...c })),
      };
    case 'barcode':
      return {
        outcome: 'barcode',
        code: o.barcode.code,
        lookupEnabled: o.barcode.lookupEnabled,
      };
    case 'not_kept':
      return { outcome: 'not_kept', text: o.text };
  }
}

/** Offline, and the phone didn't know it. */
export function offlineAnswer(scan: ScanResult, text: string): Resolution {
  switch (scan.kind) {
    case 'kept':
      return { outcome: 'not_on_phone', text, code: scan.code };
    case 'homebox':
      return { outcome: 'not_on_phone', text, code: null };
    case 'barcode':
      return { outcome: 'barcode', code: scan.code, lookupEnabled: null };
    case 'other':
      return { outcome: 'not_kept', text: scan.text };
  }
}

export async function resolveScan(read: Read, deps: ResolveDeps): Promise<Resolution> {
  const scan = parseScan(read.text, read.format);
  if (deps.store)
    for (const resolve of deps.resolvers ?? LOCAL_RESOLVERS) {
      const hit = await resolve(scan, deps.store, read.text);
      if (hit) return hit;
    }
  if (deps.online) {
    const server = deps.server ?? captureApi.resolveScan;
    try {
      return fromServer(
        scan,
        await server({ text: read.text, ...(read.format ? { format: read.format } : {}) }),
      );
    } catch (e) {
      if (!isOffline(e)) throw e;
    }
  }
  return offlineAnswer(scan, read.text.trim());
}

// ----- after a scan -----------------------------------------------------------------------------

/**
 * "Not on this phone; it will check when you're online": the text read is kept as a notice, and
 * the scan screen re-checks it once online. A store without notices (the demo) just forgets it.
 */
export async function rememberPendingScan(store: ScanStore | null, text: string): Promise<void> {
  if (!store?.addNotice) return;
  const pending = await store.notices();
  if (pending.some((n) => n.kind === 'scan_pending' && n.code === text)) return;
  await store.addNotice({ kind: 'scan_pending', code: text });
}

export const pendingScans = async (store: ScanStore | null): Promise<SyncNotice[]> =>
  store ? (await store.notices()).filter((n) => n.kind === 'scan_pending' && !!n.code) : [];

type QueueInput = Omit<QueueItem, 'clientVersion' | 'payloadVersion'>;

/** One op for the phone's queue; the sync engine sends it when online. */
export function queueItem(
  op: QueueItem['op'],
  locationId: string,
  payload: unknown,
  { key, dependsOn }: { key?: string; dependsOn?: string[] } = {},
): QueueInput {
  const clientId = newId();
  return {
    clientId,
    idempotencyKey: key ?? `${op}:${clientId}`,
    op,
    takenAt: new Date().toISOString(),
    locationId,
    ...(dependsOn?.length ? { dependsOn } : {}),
    payload,
  };
}

/**
 * The search a scanned thing opens with: a box leads with its photo grid (D195), anything else
 * opens plain (UI audit L10: every `/l/<code>` added `?view=photos`). The phone's snapshot says
 * which is a container; for a thing it doesn't hold yet, the thing itself is fetched into the
 * query cache the page reads next. If that can't be had, it opens plain.
 */
export async function openSearch(
  target: ScanTarget,
  store: OfflineStore | null,
  qc: QueryClient,
): Promise<{ view?: 'photos' }> {
  if (target.kind !== 'thing') return {};
  const known = store ? await store.thing(target.id).catch(() => undefined) : undefined;
  const isContainer =
    known?.isContainer ??
    (await qc
      .fetchQuery({
        queryKey: inventoryKeys.things.detail(target.id),
        queryFn: () => inventoryApi.thing(target.id),
      })
      .then((t) => t.isContainer)
      .catch(() => false));
  return isContainer ? { view: 'photos' } : {};
}

/**
 * Opening a thing by its label marks it seen (D40): online, `POST /things/:id/seen` (audited);
 * offline, or when that call can't reach the server, a `mark_seen` op in the queue. A viewer
 * only looks (screens §5, "A viewer's thing detail": no Mark seen): nothing is sent or queued,
 * where it was a 403 online and a dropped change at the next sync offline.
 */
export async function markSeen(
  target: ScanTarget,
  { store, online }: { store: OfflineStore | null; online: boolean },
): Promise<'sent' | 'queued' | 'skipped'> {
  if (target.kind !== 'thing') return 'skipped';
  // The role from the phone's snapshot, which holds the locations this person can see.
  const role = store && target.locationId ? await roleOf(store, target.locationId) : null;
  if (role && !can(role, 'things.mark-seen')) return 'skipped';
  if (online) {
    try {
      await inventoryApi.seen(target.id);
      return 'sent';
    } catch (e) {
      if (!isOffline(e)) return 'skipped';
    }
  }
  // A queued op needs the location; a server candidate without one is only marked online.
  if (!store || !target.locationId) return 'skipped';
  await store.enqueue(
    queueItem('mark_seen', target.locationId, { thingId: target.id }, { key: `seen:${newId()}` }),
    [],
  );
  return 'queued';
}

async function roleOf(store: OfflineStore, locationId: string): Promise<Role | null> {
  try {
    return (await store.locations()).find((l) => l.id === locationId)?.role ?? null;
  } catch {
    return null;
  }
}

/** The queued `create_thing` ops among `ids`: things captured on this phone, not yet synced. */
export async function unsyncedCaptures(store: OfflineStore | null, ids: readonly string[]) {
  if (!store) return [];
  const want = new Set(ids);
  return (await store.pending()).filter(
    (e) => e.op === 'create_thing' && want.has((e.payload as { id?: string }).id ?? ''),
  );
}
