/**
 * What a box check checks (D40; plan T26, Q25): the container's **direct** contents. From the
 * server when online (the freshest), else from the phone's snapshot, so a box check works in a
 * garage with no signal. A box inside the box is one line, checked as a unit, never opened.
 */
import { can, type Role } from '@kept/shared';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import type { OfflineStore } from '@/offline/store';

export type BoxLine = {
  id: string;
  name: string | null;
  shortCode: string | null;
  /** What the record says is there. */
  quantity: number;
  /** The same, as the decimal string the op sends back (D183). */
  expected: string;
  isContainer: boolean;
  /** For a box inside: how many things it holds, when the phone knows. */
  inside: number | null;
};

export type BoxData = {
  container: { id: string; name: string | null; shortCode: string | null; locationId: string };
  lines: BoxLine[];
  from: 'server' | 'phone';
  /** The phone's answer is "as of last sync" (D188). */
  asOf: string | null;
};

const PAGE = 200;

async function fromServer(id: string): Promise<BoxData> {
  const [box, first] = await Promise.all([
    inventoryApi.thing(id),
    inventoryApi.things({ containerId: id, limit: PAGE }),
  ]);
  const rows = [...first.items];
  let cursor = first.next_cursor;
  while (cursor && rows.length < 2000) {
    const next = await inventoryApi.things({ containerId: id, limit: PAGE, cursor });
    rows.push(...next.items);
    cursor = next.next_cursor;
  }
  return {
    container: { id: box.id, name: box.name, shortCode: box.shortCode, locationId: box.locationId },
    lines: rows.map((r) => ({
      id: r.id,
      name: r.name,
      shortCode: r.shortCode,
      quantity: r.quantity,
      expected: String(r.quantity),
      isContainer: r.isContainer,
      inside: null,
    })),
    from: 'server',
    asOf: null,
  };
}

async function fromPhone(id: string, store: OfflineStore): Promise<BoxData | null> {
  const box = await store.thing(id);
  if (!box) return null;
  const rows = await store.contentsOf({ containerId: id });
  const lines: BoxLine[] = [];
  for (const r of rows) {
    lines.push({
      id: r.id,
      name: r.name,
      shortCode: r.shortCode,
      quantity: Number(r.quantity) || 1,
      expected: r.quantity,
      isContainer: r.isContainer,
      inside: r.isContainer ? (await store.contentsOf({ containerId: r.id })).length : null,
    });
  }
  return {
    container: { id: box.id, name: box.name, shortCode: box.shortCode, locationId: box.locationId },
    lines,
    from: 'phone',
    asOf: await store.asOf(),
  };
}

export async function loadBox(
  id: string,
  { store, online }: { store: OfflineStore | null; online: boolean },
): Promise<BoxData | null> {
  if (online) {
    try {
      return await fromServer(id);
    } catch (e) {
      if (!(isApiError(e) && e.code === 'offline')) throw e;
    }
  }
  return store ? fromPhone(id, store) : null;
}

/** Whether this role may check a box (members and above, `things.mark-seen`). */
export const canCheck = (role: Role | null | undefined) => !!role && can(role, 'things.mark-seen');
