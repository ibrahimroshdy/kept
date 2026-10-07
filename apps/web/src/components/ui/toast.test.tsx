import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { toast, toastQueue } from './toast';

afterEach(() => {
  act(() => toastQueue.clear());
});

describe('Toast', () => {
  it('shows a toast in a labelled notifications region', async () => {
    await renderUI(<div />);
    act(() => {
      toast({ title: 'Moved to Garage', description: 'Cordless drill' });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveTextContent('Moved to Garage');
    expect(region).toHaveTextContent('Cordless drill');
  });

  it('sits above the phone tab bar, and 1.5rem up from the corner from md up', async () => {
    await renderUI(<div />);
    act(() => {
      toast({ title: 'Captured' });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveClass('bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)]');
    expect(region).toHaveClass('md:bottom-6');
    expect(region).not.toHaveClass('bottom-6');
  });

  it('runs its action and closes, from the keyboard', async () => {
    const onAction = vi.fn();
    const { user } = await renderUI(<div />);
    act(() => {
      toast({ title: 'Moved to Garage', action: { label: 'Undo', onAction } });
    });
    screen.getByRole('button', { name: 'Undo' }).focus();
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByText('Moved to Garage')).not.toBeInTheDocument();
  });

  it('closes with its Close button', async () => {
    const { user } = await renderUI(<div />);
    act(() => {
      toast({ title: 'Saved' });
    });
    screen.getByRole('button', { name: 'Close' }).focus();
    await user.keyboard(' ');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('renders RTL with a translated region label', async () => {
    await renderUI(<div />, { locale: 'ar' });
    act(() => {
      toast({ title: 'نُقل إلى المرآب', tone: 'ok' });
    });
    expect(screen.getByRole('region', { name: 'الإشعارات' })).toHaveTextContent('نُقل إلى المرآب');
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
