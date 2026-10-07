import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { PasswordField } from './password-field';

describe('PasswordField', () => {
  it('renders a masked input with the right autocomplete', async () => {
    await renderUI(<PasswordField label="Password" autoComplete="new-password" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
  });

  it('reveals and hides from the keyboard', async () => {
    const { user } = await renderUI(<PasswordField label="Password" />);
    await user.tab();
    await user.keyboard('hunter2hunter2');
    await user.tab();
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.keyboard(' ');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('renders RTL with translated controls', async () => {
    await renderUI(<PasswordField label="كلمة المرور" />, { locale: 'ar' });
    expect(screen.getByRole('button', { name: 'إظهار كلمة المرور' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
