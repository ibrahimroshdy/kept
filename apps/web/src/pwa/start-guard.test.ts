/**
 * index.html's start guard: one reload when the entry module never ran (a module of its graph
 * failed to load, seen on CI as a blank page that made no request), never a loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const script =
  [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? '')
    .find((body) => body.includes('kept.bootRetry')) ?? '';

let reload: ReturnType<typeof vi.fn>;
let added: { type: string; fn: EventListener }[];

beforeEach(() => {
  sessionStorage.clear();
  delete window.__keptStarted;
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  added = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    fn: EventListener,
    o?: boolean | AddEventListenerOptions,
  ) => {
    added.push({ type, fn });
    add(type, fn, o);
  }) as typeof window.addEventListener);
  new Function(script)();
});

afterEach(() => {
  for (const { type, fn } of added) {
    window.removeEventListener(type, fn);
    window.removeEventListener(type, fn, true);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fire = (type: 'load' | 'error', target?: EventTarget) => {
  for (const a of added.filter((x) => x.type === type)) {
    const e = new Event(type);
    if (target) Object.defineProperty(e, 'target', { value: target });
    a.fn(e);
  }
};

const moduleScript = () => {
  const s = document.createElement('script');
  s.type = 'module';
  return s;
};

describe('the start guard (index.html)', () => {
  it('is in index.html, before the entry module', () => {
    expect(script).not.toBe('');
    expect(indexHtml.indexOf('kept.bootRetry')).toBeLessThan(
      indexHtml.indexOf('<script type="module"'),
    );
  });

  it('reloads once at load when the entry never ran', () => {
    fire('load');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('kept.bootRetry')).toBe('1');
  });

  it('reloads when a module script fails to load', () => {
    fire('error', moduleScript());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the entry ran', () => {
    window.__keptStarted = true;
    fire('error', moduleScript());
    fire('load');
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores other errors: an image, a classic script', () => {
    fire('error', document.createElement('img'));
    fire('error', document.createElement('script'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('never loops: a second failure in a row leaves the page as it is', () => {
    sessionStorage.setItem('kept.bootRetry', '1');
    fire('load');
    expect(reload).not.toHaveBeenCalled();
  });
});
