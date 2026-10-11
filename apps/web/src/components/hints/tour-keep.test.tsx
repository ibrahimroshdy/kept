/**
 * Keep/Discard at the end of the guided tour: no dialog when the tour added nothing,
 * Keep leaves everything, Discard removes newest-first and says what stayed behind.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { TourKeepDialog } from './tour-keep';
import { type TourLedgerEntry, tourLedger } from './tour-ledger';

const IDS: TourLedgerEntry[] = [
  { kind: 'capture', id: 'c1' },
  { kind: 'thing', id: 't1' },
];

const noop = async () => {};

/** The engine passes `tourLedger.list()` as `ids`; the tests do the same. */
function seedLedger() {
  tourLedger.clear();
  for (const entry of IDS) tourLedger.record(entry.kind, entry.id);
}

beforeEach(() => tourLedger.clear());

describe('TourKeepDialog', () => {
  it('renders no dialog for an empty ledger', async () => {
    await renderUI(<TourKeepDialog ids={[]} onKeep={() => {}} onDiscard={noop} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps everything on Keep', async () => {
    const onKeep = vi.fn();
    const onDiscard = vi.fn(noop);
    const { user } = await renderUI(
      <TourKeepDialog ids={IDS} onKeep={onKeep} onDiscard={onDiscard} />,
    );
    expect(screen.getByRole('dialog', { name: 'Keep what you added?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expectLogicalOnly();
  });

  it('discards newest-first and finishes when everything goes', async () => {
    seedLedger();
    const calls: string[] = [];
    const onKeep = vi.fn();
    const { user } = await renderUI(
      <TourKeepDialog
        ids={IDS}
        onKeep={onKeep}
        onDiscard={async (_kind, id) => {
          calls.push(id);
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onKeep).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['t1', 'c1']);
  });

  it('surfaces the failure and stays open when a delete fails', async () => {
    seedLedger();
    const onKeep = vi.fn();
    const { user } = await renderUI(
      <TourKeepDialog
        ids={IDS}
        onKeep={onKeep}
        onDiscard={async (_kind, id) => {
          if (id === 't1') throw new Error('offline');
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onKeep).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
