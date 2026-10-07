import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { TextField } from './text-field';

describe('TextField', () => {
  it('renders a labelled input with its description', async () => {
    await renderUI(<TextField label="Name" description="What you would call it out loud." />);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAccessibleDescription('What you would call it out loud.');
  });

  it('is reached with Tab and takes typing', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<TextField label="Name" onChange={onChange} />);
    await user.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.keyboard('Drill');
    expect(onChange).toHaveBeenLastCalledWith('Drill');
  });

  it('shows the error and marks the input invalid', async () => {
    await renderUI(<TextField label="Email" isInvalid errorMessage="Enter an email address." />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter an email address.')).toBeInTheDocument();
  });

  it('renders RTL', async () => {
    await renderUI(<TextField label="الاسم" defaultValue="مثقاب لاسلكي" />, { locale: 'ar' });
    expect(screen.getByLabelText('الاسم')).toHaveValue('مثقاب لاسلكي');
    expectLogicalOnly();
  });
});
