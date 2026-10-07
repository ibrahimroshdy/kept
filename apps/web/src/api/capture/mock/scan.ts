/**
 * Mock handlers for scan resolution, barcode lookup and box checks (T17). Resolution starts from
 * @kept/shared's `parseScan`, like the server; `not_in_your_kept` is the same answer for a
 * missing, forbidden or retired code and for another household's blank (D137). Opening doesn't
 * mark anything seen: the client calls `POST /things/:id/seen` afterwards (D40).
 */
import { parseScan } from '@kept/shared';
import { storedCode } from '../../inventory/mock/codes';
import { accessOf, liveThing, newId, now } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, route, sessionGate } from '../../mock/kit';
import { capturePaths as p } from '../paths';
import type { BoxCheckBody, BoxCheckResult, ScanOutcome, ScanResolveBody } from '../types';

export function scanRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);

  return [
    route('POST', p.scanResolve, ({ body }): unknown => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as ScanResolveBody;
      const scan = parseScan(b.text, b.format);
      const miss: ScanOutcome = { outcome: 'not_in_your_kept' };
      // As the server does before a miss: the text as typed among the CSV and own codes (T18,
      // D208), which resolve whatever the scan's kind. A short ID wins over a code of the same text.
      const typed = storedCode(b.text);
      const anyLegacy = (): ScanOutcome | null => {
        const hits = cap().legacyCodes.filter(
          (c) => c.source !== 'homebox' && c.code === typed && access().visible(c.locationId),
        );
        const live = hits.filter((h) =>
          h.target.kind === 'thing'
            ? !!liveThing(inv(), h.target.id)
            : inv().places.some((x) => x.id === h.target.id && !x.deletedAt),
        );
        const [only] = live;
        return live.length === 1 && only
          ? { outcome: 'open', target: { ...only.target, locationId: only.locationId } }
          : null;
      };
      if (scan.kind !== 'homebox') {
        const shortHit =
          scan.kind === 'kept' &&
          (inv().things.some((x) => x.shortCode === scan.code && !x.deletedAt) ||
            inv().places.some((x) => x.shortCode === scan.code && !x.deletedAt) ||
            cap().codes.some((c) => c.code === scan.code));
        const legacy = shortHit ? null : anyLegacy();
        if (legacy) return legacy;
      }
      switch (scan.kind) {
        case 'kept': {
          const t = inv().things.find((x) => x.shortCode === scan.code && !x.deletedAt);
          if (t && access().visible(t.locationId))
            return {
              outcome: 'open',
              target: { kind: 'thing', id: t.id, locationId: t.locationId },
            };
          const pl = inv().places.find((x) => x.shortCode === scan.code && !x.deletedAt);
          if (pl && access().visible(pl.locationId))
            return {
              outcome: 'open',
              target: { kind: 'place', id: pl.id, locationId: pl.locationId },
            };
          const code = cap().codes.find((c) => c.code === scan.code);
          if (code?.state === 'blank' && access().canWrite(code.locationId))
            return { outcome: 'claim', locationId: code.locationId };
          if (code?.state === 'assigned' && code.target && access().visible(code.locationId))
            return {
              outcome: 'open',
              target: { kind: code.target.kind, id: code.target.id, locationId: code.locationId },
            };
          return miss;
        }
        case 'homebox': {
          // D146: one visible match opens; the same asset ID in two collections asks which.
          const value = scan.assetId ?? scan.uuid;
          const hits = cap().legacyCodes.filter(
            (c) => c.source === 'homebox' && c.code === value && access().visible(c.locationId),
          );
          const live = hits.flatMap((h) => {
            const loc = state.locations.find((l) => l.id === h.locationId);
            if (h.target.kind === 'thing') {
              const t = liveThing(inv(), h.target.id);
              return t ? [{ h, name: t.name ?? '', locationName: loc?.name ?? '' }] : [];
            }
            const pl = inv().places.find((x) => x.id === h.target.id && !x.deletedAt);
            return pl ? [{ h, name: pl.name, locationName: loc?.name ?? '' }] : [];
          });
          const [only] = live;
          if (live.length === 1 && only)
            return {
              outcome: 'open',
              target: { ...only.h.target, locationId: only.h.locationId },
            };
          if (live.length > 1)
            return {
              outcome: 'legacy_ambiguous',
              candidates: live.map((x) => ({
                locationName: x.locationName,
                locationId: x.h.locationId,
                name: x.name,
                kind: x.h.target.kind,
                id: x.h.target.id,
              })),
            };
          return miss;
        }
        case 'barcode':
          return {
            outcome: 'barcode',
            barcode: { code: scan.code, lookupEnabled: cap().barcodeLookup },
          };
        default:
          return { outcome: 'not_kept', text: scan.text };
      }
    }),

    route('GET', p.barcode(':code'), ({ params }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      if (!cap().barcodeLookup) return { enabled: false };
      const product = cap().products[params.code ?? ''];
      return {
        enabled: true,
        found: !!product,
        ...(product ? { product } : {}),
        attribution: 'Open Food Facts (ODbL)',
      };
    }),

    route('POST', p.thingBoxCheck(':id'), ({ params, body }) => {
      const box = liveThing(inv(), params.id ?? null);
      if (!box || !access().visible(box.locationId)) return notFound();
      if (!access().canWrite(box.locationId)) return forbidden();
      const b = body as BoxCheckBody;
      const result: BoxCheckResult = {
        boxCheckId: b.id,
        seen: [],
        notHere: [],
        split: [],
        movedIn: [],
      };
      for (const line of b.lines) {
        const t = liveThing(inv(), line.thingId);
        if (!t || t.containerId !== box.id)
          return err(400, 'validation', 'Only what is directly in the box can be checked.');
        const found = Number(line.foundQty);
        const expected = Number(line.expectedQty);
        if (found >= expected) {
          t.lastSeenAt = now();
          t.locationUncertain = false;
          result.seen.push(t.id);
        } else if (found === 0) {
          t.locationUncertain = true;
          result.notHere.push(t.id);
        } else {
          // D10: the found part stays and is seen; the missing part becomes a row marked not here.
          const rest = { ...t, id: newId(), quantity: expected - found, locationUncertain: true };
          t.quantity = found;
          t.lastSeenAt = now();
          inv().things.push(rest);
          result.split.push({ originalId: t.id, newId: rest.id });
        }
      }
      for (const id of b.foundElsewhereIds ?? []) {
        const t = liveThing(inv(), id);
        if (!t || t.locationId !== box.locationId) continue;
        t.placeId = null;
        t.containerId = box.id;
        t.lastSeenAt = now();
        result.movedIn.push(t.id);
      }
      return result;
    }),

    route('GET', p.thingBoxChecks(':id'), ({ params }) => {
      const box = liveThing(inv(), params.id ?? null);
      if (!box || !access().visible(box.locationId)) return notFound();
      return { items: [], next_cursor: null };
    }),
  ];
}
