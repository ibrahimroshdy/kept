import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantIcon } from '@/components/icons';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Button } from './button';

describe('Button', () => {
  it('renders a button with its label and variant', async () => {
    await renderUI(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('data-variant', 'danger');
  });

  it('is operated from the keyboard with Enter and Space', async () => {
    const onPress = vi.fn();
    const { user } = await renderUI(<Button onPress={onPress}>Save</Button>);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled', async () => {
    const onPress = vi.fn();
    const { user } = await renderUI(
      <Button isDisabled onPress={onPress}>
        Save
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders RTL with logical spacing only', async () => {
    await renderUI(
      <div>
        <Button>حفظ</Button>
        <Button variant="ghost" size="icon" aria-label="المساعد">
          <AssistantIcon />
        </Button>
      </div>,
      { locale: 'ar' },
    );
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('button', { name: 'المساعد' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
