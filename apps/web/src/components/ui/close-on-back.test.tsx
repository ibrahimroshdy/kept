/**
 * Back closes the top sheet first (screens §1): CloseOnBack inside the sheets and dialogs.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/places/sheet';
import { renderUI } from '@/test/render';

function Harness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(true);
  const [inner, setInner] = useState(nested);
  return (
    <>
      <p>{open ? 'outer open' : 'outer closed'}</p>
      <Sheet isOpen={open} onOpenChange={setOpen} title="Filters">
        <p>{inner ? 'inner open' : 'inner closed'}</p>
        <Sheet isOpen={inner} onOpenChange={setInner} title="Person">
          <p>picking</p>
        </Sheet>
      </Sheet>
    </>
  );
}

const back = (state: unknown) =>
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });

// Each case's sheets close inside it, not in the next one: a sheet still open at the end takes its
// entry back off on a later task (and jsdom's history.back() traverses on another), which would
// otherwise land after the next case's spy and entry (the "back called 1 times" flake, PR #75).
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  window.history.replaceState(null, '');
});

describe('CloseOnBack', () => {
  it('an open sheet holds a history entry of its own, and Back closes it', async () => {
    const before = window.history.length;
    await renderUI(<Harness />);
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state).toMatchObject({ keptSheet: 1 });
    await back(null);
    await waitFor(() => expect(screen.getByText('outer closed')).toBeInTheDocument());
  });

  it('with sheets stacked, Back closes only the top one', async () => {
    await renderUI(<Harness nested />);
    expect(await screen.findByText('picking')).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ keptSheet: 2 });
    await back({ keptSheet: 1 });
    await waitFor(() => expect(screen.getByText('inner closed')).toBeInTheDocument());
    expect(screen.getByText('outer open')).toBeInTheDocument();
  });

  it('one sheet closed as another opens at its depth: the new one keeps its entry and stays open', async () => {
    // The closed sheet takes its entry back off on a later task. By then the new sheet has pushed
    // an entry at the same depth and address; only the closed sheet's own entry may be popped.
    function Swap() {
      const [which, setWhich] = useState<'a' | 'b'>('a');
      // One slot, a different sheet in it: the first unmounts in the commit the second mounts in.
      return which === 'a' ? (
        <Sheet key="a" isOpen onOpenChange={() => {}} title="First">
          <button type="button" onClick={() => setWhich('b')}>
            Next
          </button>
        </Sheet>
      ) : (
        <Sheet key="b" isOpen onOpenChange={() => {}} title="Second">
          <p>second</p>
        </Sheet>
      );
    }
    const backs = vi.spyOn(window.history, 'back');
    try {
      await renderUI(<Swap />);
      await screen.findByRole('dialog', { name: 'First' });
      act(() => screen.getByRole('button', { name: 'Next' }).click());
      expect(await screen.findByRole('dialog', { name: 'Second' })).toBeInTheDocument();
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(backs).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    } finally {
      backs.mockRestore();
    }
  });

  // Keep this case last: the beforeunload it fires counts the page as leaving for 2 s, for any
  // case after it in this file.
  it('closed while the page is leaving, it leaves the history alone (a load in flight survives)', async () => {
    function One() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet isOpen={open} onOpenChange={setOpen} title="Filters">
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </Sheet>
      );
    }
    const backs = vi.spyOn(window.history, 'back');
    try {
      await renderUI(<One />);
      await screen.findByRole('dialog', { name: 'Filters' });
      // A full-page navigation has begun (page.goto, or location.href set): beforeunload fired.
      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });
      screen.getByRole('button', { name: 'Done' }).click();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await new Promise((r) => setTimeout(r, 20));
      expect(backs).not.toHaveBeenCalled();
    } finally {
      backs.mockRestore();
    }
  });
});
