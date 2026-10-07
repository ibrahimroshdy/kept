import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  idsOf,
  licenceFilesIn,
  licenceOf,
  nameOfEntry,
  readStore,
  render,
  scan,
  standardText,
} from './third-party-notices.mjs';

let root;
let store;
let texts;

/** One pnpm store entry: `<store>/<entry>/node_modules/<name>/` with a package.json and files. */
function entry(dirName, pkg, files = {}) {
  const dir = join(store, dirName, 'node_modules', ...pkg.name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const MIT_A = 'MIT License\n\nCopyright (c) Bruce\n\nPermission is hereby granted…';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kept-notices-'));
  store = join(root, '.pnpm');
  texts = join(root, 'texts');
  mkdirSync(store);
  mkdirSync(texts);
  writeFileSync(join(texts, 'MIT.txt'), 'MIT standard text');
  writeFileSync(join(texts, 'LGPL-3'), 'LGPL v3 text');
  writeFileSync(join(texts, 'GPL-3'), 'GPL v3 text');
  // Two peer variants of one package: listed once.
  entry(
    'alpha@1.0.0_react@19.3.0',
    { name: 'alpha', version: '1.0.0', license: 'MIT' },
    {
      LICENSE: MIT_A,
    },
  );
  entry(
    'alpha@1.0.0_react@18.0.0',
    { name: 'alpha', version: '1.0.0', license: 'MIT' },
    {
      LICENSE: MIT_A,
    },
  );
  // Same text as alpha, CRLF and extra spacing: shares alpha's copy.
  entry(
    'beta@2.0.0',
    { name: 'beta', version: '2.0.0', license: 'MIT' },
    {
      'LICENSE.md': MIT_A.replace(/\n/g, '\r\n'),
    },
  );
  entry(
    '@scope+gamma@3.0.0',
    { name: '@scope/gamma', version: '3.0.0', license: { type: 'Apache-2.0' } },
    { NOTICE: 'Gamma notice', 'LICENSE.txt': 'Apache text' },
  );
  // No licence file: the standard text.
  entry('delta@4.0.0', {
    name: 'delta',
    version: '4.0.0',
    license: 'MIT',
    repository: { url: 'git+https://example.org/delta.git' },
  });
  entry('@img+sharp-libvips-linux-arm64@1.3.3', {
    name: '@img/sharp-libvips-linux-arm64',
    version: '1.3.3',
    license: 'LGPL-3.0-or-later',
  });
  mkdirSync(join(store, 'node_modules'));
  writeFileSync(join(store, '.modules.yaml'), '');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('store entries', () => {
  it('names plain and scoped entries', () => {
    expect(nameOfEntry('alpha@1.0.0_react@19.3.0')).toBe('alpha');
    expect(nameOfEntry('@scope+gamma@3.0.0')).toBe('@scope/gamma');
    expect(nameOfEntry('node_modules')).toBeNull();
  });

  it('reads the licence in every package.json form', () => {
    expect(licenceOf({ license: 'MIT' })).toBe('MIT');
    expect(licenceOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licenceOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    );
    expect(licenceOf({})).toBe('UNKNOWN');
  });

  it('lists LICENSE before NOTICE', () => {
    const dir = join(store, '@scope+gamma@3.0.0', 'node_modules', '@scope', 'gamma');
    expect(licenceFilesIn(dir).map((f) => f.name)).toEqual(['LICENSE.txt', 'NOTICE']);
  });

  it('lists each name@version once, sorted', () => {
    const ids = readStore(store).map((p) => `${p.name}@${p.version}`);
    expect(ids).toEqual([
      '@img/sharp-libvips-linux-arm64@1.3.3',
      '@scope/gamma@3.0.0',
      'alpha@1.0.0',
      'beta@2.0.0',
      'delta@4.0.0',
    ]);
  });
});

describe('the licence scan', () => {
  it('passes the allowlist and the libvips exception', () => {
    const result = scan(readStore(store));
    expect(result.violations).toEqual([]);
    expect(result.excepted.map((e) => e.name)).toEqual(['@img/sharp-libvips-linux-arm64']);
  });

  it('fails a copyleft package', () => {
    const result = scan([{ name: 'bad', version: '1.0.0', licence: 'GPL-3.0-only', files: [] }]);
    expect(result.violations).toEqual([
      { name: 'bad', versions: '1.0.0', licence: 'GPL-3.0-only' },
    ]);
  });
});

describe('standard texts', () => {
  it('finds a text by SPDX id or its Debian name, the LGPL with the GPL', () => {
    expect(standardText('MIT', [texts])).toBe('MIT standard text');
    expect(standardText('LGPL-3.0-or-later', [texts])).toContain('LGPL v3 text');
    expect(standardText('LGPL-3.0-or-later', [texts])).toContain('GPL v3 text');
    expect(standardText('ISC', [texts])).toBeNull();
    expect(idsOf('(MIT OR Apache-2.0) AND ISC')).toEqual(['MIT', 'Apache-2.0', 'ISC']);
  });
});

describe('render', () => {
  const out = () =>
    render({
      packages: readStore(store),
      version: '1.2.3',
      arch: 'arm64',
      node: { version: '24.21.0', text: 'Node licence' },
      restic: { version: '0.19.1', text: 'restic licence' },
      dpkg: [{ name: 'openssh-client', version: '1:9.2p1-2+deb12u10' }],
      extras: [{ name: 'IBM Plex Sans', licence: 'OFL-1.1', text: 'OFL text' }],
      textDirs: [texts],
    });

  it('heads with the version and architecture, and lists every component', () => {
    const text = out();
    expect(text.split('\n')[0]).toBe('Third-party software in the Kept 1.2.3 image (linux/arm64)');
    for (const s of [
      'Node licence',
      'restic licence',
      '  alpha@1.0.0  MIT',
      '  @scope/gamma@3.0.0  Apache-2.0',
      '  openssh-client  1:9.2p1-2+deb12u10',
      'OFL text',
    ]) {
      expect(text).toContain(s);
    }
  });

  it('prints an identical licence text once for all its packages', () => {
    const text = out();
    expect(text.split('Copyright (c) Bruce').length - 1).toBe(1);
    expect(text).toMatch(/alpha@1\.0\.0 {2}\(MIT\)\nbeta@2\.0\.0 {2}\(MIT\)/);
  });

  it("gives a package with no file its licence's standard text, and the notes", () => {
    const text = out();
    expect(text).toContain('delta@4.0.0  (MIT)  https://example.org/delta');
    expect(text).toContain('MIT standard text');
    expect(text).toContain('LGPL v3 text');
    expect(text).toContain('prebuilt shared libraries that sharp loads at run time');
  });
});
