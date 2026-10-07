import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Switch } from './switch';

describe('Switch', () => {
  it('renders a labelled switch', async () => {
    await renderUI(<Switch>Dark theme</Switch>);
    expect(screen.getByRole('switch', { name: 'Dark theme' })).not.toBeChecked();
  });

  it('toggles with Space', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<Switch onChange={onChange}>Dark theme</Switch>);
    await user.tab();
    expect(screen.getByRole('switch')).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByRole('switch')).toBeChecked();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders RTL; the thumb moves on the inline axis', async () => {
    const { container } = await renderUI(<Switch defaultSelected>المظهر الداكن</Switch>, {
      locale: 'ar',
    });
    expect(screen.getByRole('switch', { name: 'المظهر الداكن' })).toBeChecked();
    expect(container.innerHTML).toContain('group-data-selected:ms-4');
    expectLogicalOnly();
  });
});
