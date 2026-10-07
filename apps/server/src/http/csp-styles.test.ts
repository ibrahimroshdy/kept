import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIBRARY_STYLE_HASHES, REACT_ARIA_STYLES } from './csp-styles.js';

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

// react-aria is react-aria-components' dependency in the web app; pnpm links it beside it.
const webModules = fileURLToPath(new URL('../../../web/node_modules/', import.meta.url));
const reactAria = path.join(
  realpathSync(path.join(webModules, 'react-aria-components')),
  '../react-aria',
);

/** The template literal React Aria assigns to `style.textContent`, trimmed as it does. */
function injectedStyle(file: string, vars: Record<string, string> = {}): string {
  const src = readFileSync(path.join(reactAria, 'dist/private', file), 'utf8');
  const m = /style\.textContent = `([\s\S]*?)`\.trim\(\)/.exec(src);
  if (!m?.[1]) throw new Error(`no injected style in ${file}`);
  return m[1]
    .replace(/\$\{[^}]*\$var\$(\w+)\}/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`unknown ${name} in ${file}`);
      return value;
    })
    .trim();
}

describe('the CSP hashes for React Aria’s injected styles', () => {
  it('are the hashes of the texts they name', () => {
    expect([sha(REACT_ARIA_STYLES.pressable), sha(REACT_ARIA_STYLES.preventScroll)]).toEqual([
      ...LIBRARY_STYLE_HASHES,
    ]);
  });

  it.runIf(existsSync(reactAria))('match what the installed react-aria injects', () => {
    const press = readFileSync(
      path.join(reactAria, 'dist/private/interactions/usePress.mjs'),
      'utf8',
    );
    const attr = /\$var\$PRESSABLE_ATTRIBUTE = '([^']+)'/.exec(press)?.[1] ?? '';
    expect(injectedStyle('interactions/usePress.mjs', { PRESSABLE_ATTRIBUTE: attr })).toBe(
      REACT_ARIA_STYLES.pressable,
    );
    expect(injectedStyle('overlays/usePreventScroll.mjs')).toBe(REACT_ARIA_STYLES.preventScroll);
  });
});
