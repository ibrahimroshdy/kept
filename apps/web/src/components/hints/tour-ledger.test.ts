/**
 * Tour-data ledger (task 2 of the guided tour): the run records every id its micro-actions
 * create, and Discard deletes exactly those — newest first — reporting what stayed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discardLedger, type TourLedgerKind, tourLedger } from './tour-ledger';

beforeEach(() => tourLedger.clear());

/** A deleter that refuses one id, like a fetch failing while the device is offline. */
function failOn(id: string) {
  return async (_kind: TourLedgerKind, got: string): Promise<void> => {
    if (got === id) throw new Error(`cannot delete ${id}`);
  };
}

describe('tourLedger', () => {
  it('starts empty and holds only what the tour recorded', () => {
    expect(tourLedger.list()).toEqual([]);
    tourLedger.record('capture', 'c1');
    tourLedger.record('thing', 't1');
    expect(tourLedger.list()).toEqual([
      { kind: 'capture', id: 'c1' },
      { kind: 'thing', id: 't1' },
    ]);
  });

  it('records an id once: a batch queued twice is discarded once', () => {
    tourLedger.record('capture', 'b1');
    tourLedger.record('capture', 'b1');
    tourLedger.record('thing', 'b1');
    expect(tourLedger.list()).toEqual([
      { kind: 'capture', id: 'b1' },
      { kind: 'thing', id: 'b1' },
    ]);
  });

  it('clears on demand', () => {
    tourLedger.record('capture', 'c1');
    tourLedger.clear();
    expect(tourLedger.list()).toEqual([]);
  });

  it('hands out copies: touching the list never reaches the ledger', () => {
    tourLedger.record('thing', 't1');
    const listed = tourLedger.list();
    for (const entry of listed) entry.id = 'changed';
    (listed as unknown[]).push({ kind: 'thing', id: 'ghost' });
    expect(tourLedger.list()).toEqual([{ kind: 'thing', id: 't1' }]);
  });

  it('discards in reverse order and reports the failure', async () => {
    tourLedger.record('capture', 'c1');
    tourLedger.record('thing', 't1');
    const calls: string[] = [];
    const failing = failOn('t1');
    const result = await discardLedger(async (kind, id) => {
      calls.push(id);
      return failing(kind, id);
    });
    expect(calls).toEqual(['t1', 'c1']);
    expect(result.discarded).toEqual(['c1']);
    expect(result.kept.map((k) => k.id)).toEqual(['t1']);
    expect(result.kept[0]?.error).toBeInstanceOf(Error);
  });

  it('leaves an offline failure listed as kept', async () => {
    tourLedger.record('thing', 't1');
    const result = await discardLedger(failOn('t1'));
    expect(result.discarded).toEqual([]);
    expect(result.kept.map((k) => k.id)).toEqual(['t1']);
  });

  it('never deletes ids outside the ledger', async () => {
    tourLedger.record('thing', 't1');
    // Never recorded: pre-existing data the tour didn't create.
    const outside = 'pre-existing';
    const calls: string[] = [];
    const deleter = vi.fn(async (_kind: TourLedgerKind, id: string) => {
      calls.push(id);
    });
    await discardLedger(deleter);
    expect(deleter).toHaveBeenCalledTimes(1);
    expect(deleter).toHaveBeenCalledWith('thing', 't1');
    expect(calls).toEqual(['t1']);
    expect(calls).not.toContain(outside);
  });

  it('discards an empty ledger with nothing to report', async () => {
    const deleter = vi.fn(async (_kind: TourLedgerKind, _id: string) => {});
    await expect(discardLedger(deleter)).resolves.toEqual({ discarded: [], kept: [] });
    expect(deleter).not.toHaveBeenCalled();
  });
});
