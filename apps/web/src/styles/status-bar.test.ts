/**
 * The installed app's top edge (iOS 26+, found on the maintainer's iPhone 2026-09-29): the page
 * header, the status bar's colour and the Liquid Glass strip must be one colour, and the header
 * must be opaque, or the status bar reads as a second band and scrolled content smudges through
 * behind the title. Liquid Glass itself can only be confirmed on a phone; this holds the parts a
 * browser can't show.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR } from '@/lib/prefs';

// Read from disk: vitest hands CSS imports back empty, even with ?raw.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../index.html');
const manifestText = read('../../public/manifest.webmanifest');
const css = read('./index.css');
const tokens = read('./tokens.css');
const pageSource = read('../components/page.tsx');
const labelsSource = read('../routes/_print/labels.$batchId.tsx');

/** `--paper` in tokens.css's first block (light) and its `[data-theme="dark"]` block. */
function paperOf(block: string): string {
  const m = /--paper:(#[0-9A-Fa-f]{6})/.exec(block);
  if (!m?.[1]) throw new Error('no --paper');
  return m[1];
}

describe('the status bar and the page header', () => {
  const light = paperOf(tokens.slice(0, tokens.indexOf('@media')));
  const dark = paperOf(tokens.slice(tokens.indexOf(':root[data-theme="dark"]')));

  it("paints the browser chrome in the header's colour, --paper, in both themes", () => {
    expect(THEME_COLOR).toEqual({ light, dark });
    expect(html).toContain(
      `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)" />`,
    );
    expect(html).toContain(
      `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)" />`,
    );
    // The pre-paint script points both metas at the stored theme, with the same two colours.
    expect(html).toContain(`theme === 'dark' ? '${dark}' : '${light}'`);
    expect(JSON.parse(manifestText).theme_color).toBe(light);
  });

  it('keeps the default status bar: black-translucent shortens the installed viewport', () => {
    expect(html).not.toMatch(/apple-mobile-web-app-status-bar-style[^>]*black-translucent/);
  });

  it('has the fixed strips, standalone only, top in --paper and bottom in the tab bar colour', () => {
    expect(html).toContain('<div class="status-strip" aria-hidden="true"></div>');
    expect(html).toContain(
      '<div class="status-strip status-strip-bottom" aria-hidden="true"></div>',
    );
    const standalone = css.slice(css.indexOf('@media (display-mode: standalone) {'));
    expect(standalone).toMatch(
      /\.status-strip \{[^}]*position: fixed;[^}]*inset-block-start: 0;[^}]*block-size: env\(safe-area-inset-top\);[^}]*background: var\(--paper\);/,
    );
    expect(standalone).toMatch(
      /\.status-strip-bottom \{[^}]*inset-block-end: 0;[^}]*block-size: env\(safe-area-inset-bottom\);[^}]*background: var\(--surface\);/,
    );
    expect(css).toContain('body:has([data-tab-bar]) .status-strip-bottom');
  });

  it('draws the page and label-sheet headers opaque, in --paper, with nothing blurred through', () => {
    for (const source of [pageSource, labelsSource]) {
      const header = /<header className="([^"]+)"/.exec(source)?.[1] ?? '';
      expect(header).toContain('sticky top-0');
      expect(header).toMatch(/(^|\s)bg-paper(\s|$)/);
      expect(header).not.toMatch(/backdrop-blur|bg-\w+\/\d+|bg-surface/);
    }
  });
});
