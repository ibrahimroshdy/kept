/**
 * `withinAiCap`: the demo the docs screenshots show (`?demo=…&showcase=1`) has Home's AI cap
 * 37% used, with nothing paused, while the fixtures themselves keep the pause the tests rely on.
 */
import { describe, expect, it } from 'vitest';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { ownerScenario } from '../../mock/fixtures';
import { withinAiCap } from './state';

describe('withinAiCap', () => {
  it('leaves the fixtures paused', () => {
    const { capture } = ownerScenario();
    expect(capture.aiStatus[INV_IDS.loc.home]?.pausedUntil).not.toBeNull();
    expect(capture.caps.some((c) => c.state === 'paused')).toBe(true);
  });

  it('lifts every pause a reached cap caused', () => {
    const { capture } = ownerScenario();
    withinAiCap(capture);

    for (const status of Object.values(capture.aiStatus)) {
      expect(status.pausedUntil).toBeNull();
      expect(status.reason).toBeNull();
      expect(status.pausedBy).toBeNull();
    }
    expect(capture.aiStatus[INV_IDS.loc.home]?.capPercent).toBe(37);

    const home = capture.caps.find((c) => c.target.id === INV_IDS.loc.home);
    expect(home).toMatchObject({ state: 'active', percent: 37 });
    expect(home?.used.cost).toEqual([{ currency: 'USD', amount: '1.85' }]);
    expect(home?.pausedUntil).toBeUndefined();

    const attempts = Object.values(capture.extractions).flat();
    expect(attempts.some((x) => x.status === 'paused_budget')).toBe(false);
    expect(capture.inbox.some((i) => i.extraction?.status === 'paused_budget')).toBe(false);
    expect(capture.calls.some((c) => c.outcome === 'over_budget')).toBe(false);
  });
});
