import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Button } from './button';
import { Dialog, DialogFooter, DialogTrigger, Modal } from './dialog';
import { TextField } from './text-field';

function Example({ title = 'Rename this thing' }: { title?: string }) {
  return (
    <DialogTrigger>
      <Button variant="secondary">Rename</Button>
      <Modal>
        <Dialog title={title}>
          {({ close }) => (
            <>
              <TextField label="Name" autoFocus />
              <DialogFooter>
                <Button onPress={close}>Save</Button>
              </DialogFooter>
            </>
          )}
        </Dialog>
      </Modal>
    </DialogTrigger>
  );
}

describe('Dialog', () => {
  it('opens a labelled modal dialog', async () => {
    const { user } = await renderUI(<Example />);
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename this thing' });
    expect(dialog).toBeInTheDocument();
  });

  it('opens from the keyboard, moves focus in, and Escape returns it', async () => {
    const { user } = await renderUI(<Example />);
    await user.tab();
    const trigger = screen.getByRole('button', { name: 'Rename' });
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes with its × button', async () => {
    const { user } = await renderUI(<Example />);
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders RTL with a translated close button', async () => {
    const { user } = await renderUI(<Example title="أعد تسمية هذا الشيء" />, { locale: 'ar' });
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('dialog', { name: 'أعد تسمية هذا الشيء' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
