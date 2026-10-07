import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Button } from './button';
import { useConfirm } from './confirm';

function Example({ title }: { title: string }) {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState('none');
  return (
    <>
      <Button
        onPress={async () =>
          setAnswer(String(await confirm({ title, confirmLabel: 'Remove', destructive: true })))
        }
      >
        Ask
      </Button>
      <output>{answer}</output>
    </>
  );
}

describe('useConfirm', () => {
  it('asks in an alertdialog and resolves true on confirm', async () => {
    const { user } = await renderUI(<Example title="Remove Selina from this home?" />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Remove Selina from this home?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('true')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('starts on Cancel, and Escape resolves false', async () => {
    const { user } = await renderUI(<Example title="Remove Selina from this home?" />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(await screen.findByText('false')).toBeInTheDocument();
  });

  it('never calls window.confirm', async () => {
    const spy = vi.spyOn(window, 'confirm');
    const { user } = await renderUI(<Example title="Sure?" />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders RTL with translated buttons', async () => {
    const { user } = await renderUI(<Example title="إزالة سيلينا من هذا المنزل؟" />, {
      locale: 'ar',
    });
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(
      screen.getByRole('alertdialog', { name: 'إزالة سيلينا من هذا المنزل؟' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إلغاء' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
