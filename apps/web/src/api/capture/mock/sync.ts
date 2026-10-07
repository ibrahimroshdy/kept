/**
 * Mock handlers for the sync protocol (T12, T14): the snapshot as one complete page built from
 * the inventory (no money, secrets, documents or contact details, D36, D159), and the ops
 * endpoint with the payload-version window (D148, Q3) and idempotent replays. The ops apply the
 * common cases (create a thing, move, mark seen, not here); a move into a trashed place is
 * `dropped` / `target_trashed` with a notice, and opens a `sync_drop` inbox item (D35).
 */
import {
  MIN_PAYLOAD_VERSION,
  PAYLOAD_VERSION,
  parseOpPayload,
  payloadVersionStatus,
  type SnapshotPage,
  type SyncOpResult,
  type SyncOpsRequest,
  upgradePayload,
} from '@kept/shared';
import { accessOf, liveThing, newId, now, type StoredThing } from '../../inventory/mock/db';
import { contentsTemplate } from '../../inventory/mock/places';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, route, sessionGate } from '../../mock/kit';
import { capturePaths as p } from '../paths';
import { allocateCode } from './capture';

/** "Suggest where I am" radius when a location sets none (D153). */
const SUGGEST_RADIUS_M = 150;

export function syncRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);

  const snapshot = (): SnapshotPage => {
    const visible = access().visibleIds();
    cap().snapshotPass += 1;
    return {
      asOf: now(),
      payloadVersion: PAYLOAD_VERSION,
      minPayloadVersion: MIN_PAYLOAD_VERSION,
      locations: state.locations.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        timezone: l.timezone,
        languages: l.languages ?? ['en'],
        role: l.role,
        effectiveModules: l.modules,
        unplacedPlaceId:
          inv().places.find((pl) => pl.locationId === l.id && pl.isUnplaced)?.id ?? '',
        suggestRadiusM: SUGGEST_RADIUS_M,
      })),
      types: {
        hash: `types-${inv().types.length}`,
        items: inv().types.map((t) => ({
          id: t.id,
          builtinKey: t.builtinKey,
          name: t.name ?? t.builtinKey ?? '',
          icon: t.icon,
          isContainer: t.resolvedCapabilities.includes('container'),
        })),
      },
      changes: {
        places: inv()
          .places.filter((pl) => visible.has(pl.locationId))
          .map((pl) => ({
            id: pl.id,
            locationId: pl.locationId,
            parentId: pl.parentId,
            name: pl.name,
            kindKey: pl.kindKey,
            icon: pl.icon,
            isUnplaced: pl.isUnplaced,
            sort: pl.sort,
            deleted: pl.deletedAt !== null,
          })),
        things: inv()
          .things.filter((t) => visible.has(t.locationId))
          .map((t) => ({
            id: t.id,
            locationId: t.locationId,
            shortCode: t.shortCode,
            name: t.name,
            typeId: t.type?.id ?? null,
            placeId: t.placeId,
            containerId: t.containerId,
            quantity: String(t.quantity),
            aliases: t.aliases,
            lifecycle: t.lifecycle,
            reviewState: t.reviewState,
            locationUncertain: t.locationUncertain,
            lastSeenAt: t.lastSeenAt,
            coverFileId: t.photos[0]?.file?.id ?? null,
            isContainer: t.isContainer,
            meters: t.meters.map((m) => ({
              id: m.id,
              kind: m.kind,
              unit: m.unit,
              label: m.label,
            })),
            deleted: t.deletedAt !== null,
          })),
        codes: cap()
          .codes.filter((c) => visible.has(c.locationId))
          .map((c) => ({
            code: c.code,
            locationId: c.locationId,
            thingId: c.target?.kind === 'thing' ? c.target.id : null,
            placeId: c.target?.kind === 'place' ? c.target.id : null,
            state: c.state,
            isPrimary: c.state === 'assigned',
          })),
        legacyCodes: cap()
          .legacyCodes.filter((c) => visible.has(c.locationId))
          .map((c) => ({
            locationId: c.locationId,
            source: c.source,
            sourceCollection: '',
            code: c.code,
            thingId: c.target.kind === 'thing' ? c.target.id : null,
            placeId: c.target.kind === 'place' ? c.target.id : null,
          })),
      },
      removed: [],
      revokedLocationIds: [],
      nextCursor: `pass-${cap().snapshotPass}`,
      complete: true,
    };
  };

  const apply = (item: SyncOpsRequest['ops'][number]): SyncOpResult => {
    const base = { clientId: item.clientId, idempotencyKey: item.idempotencyKey };
    const drop = (reason: string): SyncOpResult => ({ ...base, outcome: 'dropped', reason });
    if (!access().canWrite(item.locationId)) return drop('not_permitted');
    const parsed = parseOpPayload(
      item.op,
      upgradePayload(item.op, item.payloadVersion, item.payload),
    );
    if (!parsed.success) return drop('invalid');
    const payload = parsed.data as Record<string, unknown>;
    switch (item.op) {
      case 'create_thing': {
        const b = payload as {
          id: string;
          name?: string;
          mode: string;
          attachToThingId?: string;
          pageOf?: string;
          target: { placeId?: string; containerId?: string; unplaced?: true };
        };
        // "+ photo" adds files to a thing (or pages to a receipt) that exists already; a receipt
        // or a reading opens a draft purchase or reading, not a thing (as POST /captures does).
        if (b.attachToThingId) {
          const target = liveThing(inv(), b.attachToThingId);
          if (!target) return drop('target_missing');
          return { ...base, outcome: 'applied', entity: { type: 'thing', id: target.id } };
        }
        if (b.pageOf || (b.mode !== 'thing' && b.mode !== 'label'))
          return { ...base, outcome: 'applied' };
        const unplaced = inv().places.find((x) => x.locationId === item.locationId && x.isUnplaced);
        const t = {
          ...contentsTemplate(),
          id: b.id,
          locationId: item.locationId,
          shortCode: allocateCode(
            (code) =>
              inv().things.some((x) => x.shortCode === code) ||
              cap().codes.some((c) => c.code === code),
          ),
          name: b.name ?? null,
          type: null,
          placeId: b.target.placeId ?? (b.target.unplaced ? (unplaced?.id ?? null) : null),
          containerId: b.target.containerId ?? null,
          isContainer: false,
          reviewState: b.name ? 'confirmed' : 'draft',
        } as StoredThing;
        inv().things.push(t);
        // The batch, as POST /captures records it: "Undo this batch" and the inbox's grouping.
        const batchId = (payload as { batchId: string }).batchId;
        let batch = cap().batches.find((x) => x.batchId === batchId);
        if (!batch) {
          batch = {
            batchId,
            locationId: item.locationId,
            placeId: t.placeId ?? '',
            capturedAt: now(),
            createdById: state.me.user.id,
            thingIds: [],
          };
          cap().batches.unshift(batch);
        }
        batch.thingIds.push(t.id);
        return {
          ...base,
          outcome: 'applied',
          entity: { type: 'thing', id: t.id, shortCode: t.shortCode },
        };
      }
      case 'move': {
        const b = payload as { thingIds: string[]; to: { placeId?: string; containerId?: string } };
        const place = b.to.placeId ? inv().places.find((x) => x.id === b.to.placeId) : undefined;
        if (place?.deletedAt) {
          const inboxItemId = newId();
          cap().inbox.unshift({
            id: inboxItemId,
            kind: 'sync_drop',
            locationId: item.locationId,
            createdAt: now(),
            createdById: state.me.user.id,
            createdByName: null,
            rowVersion: 1,
            batchId: null,
            syncDrop: {
              op: { op: item.op, payload },
              reason: 'target_trashed',
              entity: { type: 'place', id: place.id, name: place.name },
            },
            resolvedAt: null,
            resolution: null,
          });
          return {
            ...drop('target_trashed'),
            // "<name> was trashed by <by>": what was trashed, the place it was going to (T14).
            notice: { name: place.name, by: { displayName: 'Alfred' }, action: 'trashed' },
            inboxItemId,
          };
        }
        for (const id of b.thingIds) {
          const t = liveThing(inv(), id);
          if (!t) continue;
          t.placeId = b.to.placeId ?? null;
          t.containerId = b.to.containerId ?? null;
        }
        return { ...base, outcome: 'applied' };
      }
      case 'mark_seen':
      case 'not_here': {
        const t = liveThing(inv(), (payload as { thingId: string }).thingId);
        if (!t) return drop('target_missing');
        if (item.op === 'mark_seen') {
          t.lastSeenAt = now();
          t.locationUncertain = false;
        } else t.locationUncertain = true;
        return { ...base, outcome: 'applied', entity: { type: 'thing', id: t.id } };
      }
      default:
        return { ...base, outcome: 'applied' };
    }
  };

  return [
    route('GET', p.syncSnapshot, () => sessionGate(state) ?? snapshot()),

    route('POST', p.syncOps, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as SyncOpsRequest;
      // D148: the whole batch is refused, nothing applied, and the phone keeps its queue.
      for (const op of b.ops) {
        const status = payloadVersionStatus(op.payloadVersion);
        if (status === 'client_outdated')
          return err(409, 'client_outdated', 'Update Kept to finish syncing.', undefined, {
            minPayloadVersion: MIN_PAYLOAD_VERSION,
          });
        if (status === 'server_outdated')
          return err(
            409,
            'server_outdated',
            'Kept on the server is older than this app; ask your admin.',
          );
      }
      const results = b.ops.map((op) => {
        const stored = cap().syncOps[op.idempotencyKey];
        if (stored) return stored;
        const failedParent = (op.dependsOn ?? []).some(
          (k) => cap().syncOps[k]?.outcome === 'dropped',
        );
        const result = failedParent
          ? {
              clientId: op.clientId,
              idempotencyKey: op.idempotencyKey,
              outcome: 'dropped' as const,
              reason: 'parent_dropped',
            }
          : apply(op);
        cap().syncOps[op.idempotencyKey] = result;
        return result;
      });
      return { results };
    }),
  ];
}
