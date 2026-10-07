import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINE_POINTER, resetKeyboardSeen, useKeyHints } from './key-hints';

function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKeyboardSeen();
});

describe('useKeyHints', () => {
  it('is off on a touch screen, on with a fine hovering pointer', () => {
    media([]);
    expect(renderHook(() => useKeyHints()).result.current).toBe(false);
    media([FINE_POINTER]);
    expect(renderHook(() => useKeyHints()).result.current).toBe(true);
  });

  it('turns on once a key is pressed outside a field (a hardware keyboard), not in one', () => {
    media([]);
    const { result } = renderHook(() => useKeyHints());
    const input = document.createElement('input');
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    });
    expect(result.current).toBe(false);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(result.current).toBe(false);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    expect(result.current).toBe(true);
    input.remove();
  });
});
