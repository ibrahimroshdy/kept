import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { renderUI } from '@/test/render';
import { useErrorText } from './page';

function Shown({ error }: { error: unknown }) {
  const text = useErrorText();
  return <p>{text(error)}</p>;
}

/** The 409 a move answers when the target location already has one of the codes (D208). */
const clash = (holder: string | null) =>
  new ApiError(409, 'conflict', 'Conflict', {
    details: {
      ownCode: 'SHED-7',
      taken: { kind: 'thing', id: '0199a8f0-0000-7000-8000-000000000001', name: holder },
      location: { id: '0199a8f0-0000-7000-8000-000000000002', name: 'Garage' },
    },
  });

describe('useErrorText: a move refused over a code (D208)', () => {
  it('names the code, the location and what holds it there', async () => {
    await renderUI(<Shown error={clash('Spanner')} />);
    expect(
      screen.getByText(
        'Garage already has the code SHED-7, on Spanner. Change or remove it on one of them, then move again.',
      ),
    ).toBeInTheDocument();
  });

  it('leaves out the holder when it has no name, and says it in Arabic', async () => {
    await renderUI(<Shown error={clash(null)} />, { locale: 'ar' });
    expect(
      screen.getByText('في Garage الرمز SHED-7 بالفعل. غيّره أو احذفه من أحدهما، ثم انقل مجددًا.'),
    ).toBeInTheDocument();
  });

  it('keeps the plain conflict text for any other 409', async () => {
    await renderUI(<Shown error={new ApiError(409, 'conflict', 'Conflict')} />);
    expect(
      screen.getByText('That conflicts with a change someone else made. Reload and try again.'),
    ).toBeInTheDocument();
  });
});
