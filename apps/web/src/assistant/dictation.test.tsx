/**
 * Dictation (D25, D213, V13) against a stubbed recogniser only: the real one is never started in
 * a test (agent rules; spike S6.6).
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSpeechStub, StubRecognition } from '@/test/speech';
import { dictationLang, dictationSupport, resetDictation, useDictation } from './dictation';

function Field({ locale = 'en' }: { locale?: string }) {
  const [value, setValue] = useState('In the garage');
  const d = useDictation({ locale, onText: setValue });
  return (
    <div>
      <output aria-label="value">{value}</output>
      {d.available ? (
        <button type="button" onClick={() => d.toggle(value)}>
          {d.listening ? 'Stop' : 'Mic'}
        </button>
      ) : null}
      {d.deniedNow ? <p>denied</p> : null}
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDictation();
});

describe('dictation', () => {
  it('has no mic without the API', () => {
    render(<Field />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(dictationSupport()).toBeNull();
  });

  it('puts interim, then final, words after what was typed, in the interface language', async () => {
    installSpeechStub();
    const user = userEvent.setup();
    render(<Field locale="ar-EG" />);
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    const r = StubRecognition.last;
    expect(r.started).toBe(true);
    expect(r.lang).toBe('ar');
    expect(r.interimResults).toBe(true);
    act(() => r.hear(['I have a drill'], false));
    expect(screen.getByLabelText('value')).toHaveTextContent('In the garage I have a drill');
    act(() => r.hear(['I have a drill,', ' a ladder and two paint cans'], true));
    expect(screen.getByLabelText('value')).toHaveTextContent(
      'In the garage I have a drill, a ladder and two paint cans',
    );
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Mic' })).toBeInTheDocument();
  });

  it('finds Safari’s prefixed recogniser', () => {
    installSpeechStub('webkitSpeechRecognition');
    expect(dictationSupport()).toBe('webkitSpeechRecognition');
    expect(dictationLang('fr-CA')).toBe('fr');
  });

  it('says a refused microphone once and hides the mic for the session', async () => {
    installSpeechStub();
    const user = userEvent.setup();
    render(<Field />);
    await user.click(screen.getByRole('button', { name: 'Mic' }));
    act(() => StubRecognition.last.deny());
    expect(screen.getByText('denied')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
