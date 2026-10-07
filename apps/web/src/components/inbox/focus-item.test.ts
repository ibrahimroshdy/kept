import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusInboxItem } from './inbox-list';

// `j` focuses the next item on the next frame; a key pressed before that frame wins (T32).
describe('focusInboxItem', () => {
  let frames: FrameRequestCallback[] = [];
  const flush = () => {
    for (const f of frames.splice(0)) f(0);
  };
  const setup = () => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    document.body.innerHTML =
      '<article tabindex="-1" data-inbox-item="a1"></article><input aria-label="Name" />';
    return {
      item: document.querySelector<HTMLElement>('[data-inbox-item="a1"]') as HTMLElement,
      field: document.querySelector<HTMLInputElement>('input') as HTMLInputElement,
    };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('focuses the item on the next frame', () => {
    const { item } = setup();
    focusInboxItem('a1');
    expect(document.activeElement).not.toBe(item);
    flush();
    expect(document.activeElement).toBe(item);
  });

  it('leaves focus in a field that took it before the frame (j, then e opens the form)', () => {
    const { field } = setup();
    focusInboxItem('a1');
    field.focus();
    flush();
    expect(document.activeElement).toBe(field);
  });
});
