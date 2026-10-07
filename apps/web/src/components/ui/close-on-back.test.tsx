/**
 * Back closes the top sheet first (screens §1): CloseOnBack inside the sheets and dialogs.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
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
});
