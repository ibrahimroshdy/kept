/**
 * Tour-data ledger for the full guided tour (spec §"Tour-data ledger"). While the tour runs,
 * every micro-action records what it created; the finish step reads the ledger: empty means no
 * prompt, just Done, and non-empty means the Keep/Discard dialog (`tour-keep.tsx`). Discard
 * deletes exactly these ids, newest first, through a deleter the tour engine wires to the
 * existing delete fetchers — no new endpoint, and never anything the tour didn't create.
 */

export type TourLedgerKind = 'capture' | 'thing' | 'place' | 'location' | 'label';

export type TourLedgerEntry = { kind: TourLedgerKind; id: string };

/** One delete through an existing fetcher (Trash-move); a rejection keeps the item listed. */
export type TourDeleter = (kind: TourLedgerKind, id: string) => Promise<void>;

export type DiscardResult = {
  discarded: string[];
  kept: { id: string; error: unknown }[];
};

const entries: TourLedgerEntry[] = [];

/**
 * What this tour run created, in record order. The engine clears it on start and on end;
 * `record` is only called by tour micro-actions, so pre-existing data never lands here.
 */
export const tourLedger = {
  record(kind: TourLedgerKind, id: string): void {
    entries.push({ kind, id });
  },
  list(): readonly TourLedgerEntry[] {
    return [...entries];
  },
  clear(): void {
    entries.length = 0;
  },
};

/**
 * Delete every ledger entry, newest first (a thing goes before the capture it came from),
 * and report what stayed: a rejection keeps that item listed with its error and the run
 * carries on with the rest. Ids outside the ledger are never touched.
 */
export async function discardLedger(deleter: TourDeleter): Promise<DiscardResult> {
  const discarded: string[] = [];
  const kept: { id: string; error: unknown }[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await deleter(entry.kind, entry.id);
      discarded.push(entry.id);
    } catch (error) {
      kept.push({ id: entry.id, error });
    }
  }
  return { discarded, kept };
}
