/**
 * What the wrapper hands driver.js (spike V18): physical sides mirrored in Arabic, escaped text,
 * reduced motion honoured, and the tour's arrows following the reading direction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Captured = Record<string, unknown> & { hints?: Record<string, unknown>[] };
const seen: { hints: Captured[]; tours: Captured[] } = { hints: [], tours: [] };
const tour = {
  moveNext: vi.fn(),
  movePrevious: vi.fn(),
  hasNextStep: vi.fn(() => true),
  hasPreviousStep: vi.fn(() => true),
  isActive: vi.fn(() => true),
  destroy: vi.fn(),
  drive: vi.fn(),
};

vi.mock('driver.js/hints', () => ({
  hints: (config: Captured) => {
    seen.hints.push(config);
    return { show: vi.fn(), open: vi.fn(), hide: vi.fn() };
  },
}));
vi.mock('driver.js', () => ({
  driver: (config: Captured) => {
    seen.tours.push(config);
    return tour;
  },
}));

const { showHint, runTour } = await import('./driver-kit');

afterEach(() => {
  seen.hints = [];
  seen.tours = [];
  vi.clearAllMocks();
});

const spec = (rtl: boolean) => ({
  id: 'capture.mode_strip',
  element: document.body,
  title: 'Pick <b>it</b>',
  description: 'One & two',
  buttonText: 'Got it',
  rtl,
  reducedMotion: false,
  onDismiss: () => undefined,
});

const hintOf = () =>
  seen.hints[0]?.hints?.[0] as {
    beacon: { side: string; align: string; animate: boolean };
    popover: { side: string; align: string; title: string; description: string };
  };

describe('showHint', () => {
  it('LTR: the beacon at the top end, the popover below it, opening back over the target', () => {
    showHint(spec(false));
    expect(hintOf().beacon).toMatchObject({ side: 'top', align: 'end', animate: true });
    expect(hintOf().popover).toMatchObject({ side: 'bottom', align: 'end' });
  });

  it('RTL: the same placement mirrored (driver.js aligns physically)', () => {
    showHint({ ...spec(true), side: 'end', align: 'start' });
    expect(hintOf().beacon).toMatchObject({ side: 'top', align: 'start' });
    expect(hintOf().popover).toMatchObject({ side: 'left', align: 'end' });
    showHint(spec(true));
    expect(seen.hints[1]?.hints?.[0]).toMatchObject({
      popover: { side: 'bottom', align: 'start' },
    });
  });

  it('escapes its text, and stops the pulse under reduced motion', () => {
    showHint({ ...spec(false), reducedMotion: true });
    expect(hintOf().popover.title).toBe('Pick &lt;b&gt;it&lt;/b&gt;');
    expect(hintOf().popover.description).toBe('One &amp; two');
    expect(hintOf().beacon.animate).toBe(false);
  });
});

describe('runTour', () => {
  const labels = {
    next: 'Next',
    previous: 'Previous',
    done: 'Done',
    close: 'Close',
    progress: (a: number, b: number) => `${a} of ${b}`,
  };
  const steps = [{ element: document.body, title: 'Home', description: 'Start here' }];
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));

  it("turns driver.js's own (physical) keys off and handles them by reading direction", () => {
    const onEnd = vi.fn();
    const t = runTour({ steps, rtl: true, reducedMotion: true, labels, onEnd });
    expect(seen.tours[0]).toMatchObject({ allowKeyboardControl: false, animate: false });
    key('ArrowLeft');
    expect(tour.moveNext).toHaveBeenCalledOnce();
    key('ArrowRight');
    expect(tour.movePrevious).toHaveBeenCalledOnce();
    key('Escape');
    expect(tour.destroy).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(false);
    // Ended: the keys no longer drive it.
    key('ArrowLeft');
    expect(tour.moveNext).toHaveBeenCalledOnce();
    t.destroy();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('in English ArrowRight is forward', () => {
    runTour({ steps, rtl: false, reducedMotion: false, labels, onEnd: () => undefined });
    key('ArrowRight');
    expect(tour.moveNext).toHaveBeenCalledOnce();
    key('Escape');
  });
});
