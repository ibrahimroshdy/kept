/**
 * "Keep this location available offline" (T12; D159, Q21): Home's extras, a page at a time, or
 * the estimate. Members of the location only (404 otherwise, as the server); money hidden for a
 * viewer. The device's own state (the app lock, what is kept) is `ops(state).device`, which the
 * screens (T23) read from their device store, never from the server.
 */
import { SYNC_EXTRAS_PAGE } from '@kept/shared';
import { roleIn } from '../../inventory/mock/db';
import { IDS, type MockState } from '../../mock/fixtures';
import { type MockRoute, notFound, route, sessionGate } from '../../mock/kit';
import { opsPaths as p } from '../paths';
import type { SyncExtra } from '../types';
import { ops } from './state';

export function deviceRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', p.syncExtras, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId') ?? '';
      const role = roleIn(state.locations, locationId);
      if (!role) return notFound();
      const items: SyncExtra[] =
        locationId === IDS.home
          ? ops(state).extras.map((x) =>
              // As the server (sync/extras.ts): a viewer where Home hides money gets the
              // purchase's date only, and no documents (originals are for members and above).
              role === 'viewer'
                ? {
                    ...x,
                    purchase: x.purchase ? { ...x.purchase, price: null, currency: null } : null,
                    currentValue: null,
                    moneyHidden: true,
                    documents: [],
                  }
                : x,
            )
          : [];
      const totalBytes = items.reduce(
        (sum, x) => sum + x.documents.reduce((n, d) => n + d.bytes, 0),
        0,
      );
      if (query.get('estimate') === '1') {
        return {
          things: items.length,
          documents: items.reduce((n, x) => n + x.documents.length, 0),
          totalBytes,
        };
      }
      const start = Number(query.get('cursor') ?? 0) || 0;
      const slice = items.slice(start, start + SYNC_EXTRAS_PAGE);
      const more = start + SYNC_EXTRAS_PAGE < items.length;
      return {
        items: slice,
        next_cursor: more ? String(start + SYNC_EXTRAS_PAGE) : null,
        totalBytes,
      };
    }),
  ];
}
