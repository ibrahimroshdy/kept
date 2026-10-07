// SPIKE (step 3, T0, V18): driver.js 1.8.0 hints in an RTL page, under Kept's CSP.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const BASE = 'http://127.0.0.1:4198';

async function rects(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top) };
    };
    return {
      target: r(document.querySelector('#mode-strip')),
      beacon: r(document.querySelector('.driver-hint')),
      popover: r(document.querySelector('#driver-popover-content')),
      popoverDir: (() => {
        const p = document.querySelector('#driver-popover-content');
        return p ? getComputedStyle(p).direction : null;
      })(),
      active: document.activeElement
        ? `${document.activeElement.tagName}.${document.activeElement.className}|${document.activeElement.textContent?.trim()}`
        : null,
    };
  });
}

test('beacon is a named button; keyboard opens, focus lands on "Got it"; Escape closes and returns focus', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/spike-hints.html`);
  const beacon = page.locator('button.driver-hint');
  await expect(beacon).toHaveCount(1);
  await expect(beacon).toHaveAccessibleName('اختر الوضع');
  await expect(beacon).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(beacon).toHaveAttribute('aria-expanded', 'false');

  // Tab order: the beacon is appended to <body>, so it comes after the page's own controls.
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(
        () => document.activeElement?.id || document.activeElement?.className || '',
      ),
    );
  }
  console.log('tab order', JSON.stringify(order));
  await beacon.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'اختر الوضع' });
  await expect(dialog).toBeVisible();
  await expect(beacon).toHaveAttribute('aria-expanded', 'true');
  const open = await rects(page);
  console.log('open', JSON.stringify(open));
  expect(open.active).toContain('فهمت');

  const axe = await new AxeBuilder({ page }).analyze();
  console.log(
    'axe violations (popover open)',
    JSON.stringify(
      axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
    ),
  );

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const closed = await rects(page);
  console.log('after Escape', JSON.stringify(closed));
  expect(closed.active).toContain('driver-hint');

  // Re-open by keyboard and confirm with "Got it" by keyboard: the hint is dismissed.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(beacon).toHaveCount(0);
  expect(await page.evaluate(() => window.__hintEvents)).toEqual(['open', 'open', 'dismiss']);
  console.log('focus after dismiss', JSON.stringify((await rects(page)).active));
  console.log('console errors (CSP?)', JSON.stringify(errors));
  expect(errors).toEqual([]);
});

// In hint mode (no overlay) the popover is anchored to the beacon, not the target. LTR reference:
// beacon centred on the target's top-right (inline-end) corner, popover growing rightwards from it.
// Mirrored means: beacon on the top-left corner, popover growing leftwards from it.
for (const variant of ['dir=ltr', '', 'mirror=1'] as const) {
  test(`placement: ${variant || 'rtl, no mirroring'}`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(`${BASE}/spike-hints.html${variant ? `?${variant}` : ''}`);
    await page.locator('button.driver-hint').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const r = await rects(page);
    console.log(`placement ${variant || 'rtl'}`, JSON.stringify(r));
    await page.screenshot({ path: `../../.tmp/spike-e2e/hints-${variant || 'rtl'}.png` });
    const beaconX = (r.beacon?.left ?? 0) + 12;
    if (variant === 'dir=ltr') {
      expect(r.popoverDir).toBe('ltr');
      expect(Math.abs(beaconX - (r.target?.right ?? 0))).toBeLessThan(4);
      expect(r.popover?.left ?? 0).toBeGreaterThan(beaconX - 40);
    } else if (variant === 'mirror=1') {
      expect(r.popoverDir).toBe('rtl');
      expect(Math.abs(beaconX - (r.target?.left ?? 0))).toBeLessThan(4);
      expect(r.popover?.right ?? 0).toBeLessThan(beaconX + 40);
    } else {
      // Unmirrored RTL: driver.js still uses the physical right corner (= inline-start in RTL).
      expect(r.popoverDir).toBe('rtl');
      expect(Math.abs(beaconX - (r.target?.right ?? 0))).toBeLessThan(4);
    }
  });
}

test('overlay mode: Escape still closes', async ({ page }) => {
  await page.goto(`${BASE}/spike-hints.html?mirror=1&overlay=1`);
  await page.locator('button.driver-hint').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('svg.driver-hint-overlay')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('svg.driver-hint-overlay')).toHaveCount(0);
  console.log('overlay: focus after Escape', JSON.stringify((await rects(page)).active));
});

declare global {
  interface Window {
    __hintEvents?: string[];
  }
}
