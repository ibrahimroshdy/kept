import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findLeaks,
  loadPrivateTerms,
  privateIpv4Allowed,
  scanLine,
} from './check-no-local-paths.mjs';

const rules = (file, text) => scanLine(file, text).map((f) => f.rule);

describe('scanLine', () => {
  it('finds home directories on macOS, Linux and Windows', () => {
    expect(rules('docs/a.md', 'see /Users/someone/project/x')).toEqual(['home-directory']);
    expect(rules('docs/a.md', 'see /home/someone/project/x')).toEqual(['home-directory']);
    expect(rules('docs/a.md', String.raw`see C:\Users\someone\project`)).toEqual([
      'home-directory',
    ]);
  });

  it('lets placeholders through', () => {
    expect(rules('docs/a.md', 'the pattern is `/Users/<name>/` or `-Users-<name>-`')).toEqual([]);
    expect(rules('docs/a.md', 'serves it at `https://<machine>.<tailnet>.ts.net`')).toEqual([]);
    expect(rules('docs/a.md', 'the address ends in <0>.ts.net</0>.')).toEqual([]);
  });

  it('finds temp and scratch directories', () => {
    expect(rules('docs/a.md', '/private/tmp/claude-501/-x-/scratchpad/')).toContain(
      'temp-directory',
    );
    expect(rules('docs/a.md', '/private/var/folders/ab/cd/T/x')).toContain('temp-directory');
    expect(rules('docs/a.md', '/var/folders/ab/xyz123/T/')).toEqual(['temp-directory']);
    expect(rules('docs/a.md', 'under /tmp/claude-1000/ on Linux')).toEqual(['temp-directory']);
    expect(rules('docs/a.md', 'a scratch file in /tmp/kept-docker-config')).toEqual([]);
  });

  it('finds a home path flattened into a directory name', () => {
    expect(rules('docs/a.md', 'projects/-Users-someone-code-app/x')).toEqual(['dashed-home-path']);
  });

  it('finds a real tailnet host name', () => {
    expect(rules('docs/a.md', 'https://laptop.tail1234ab.ts.net/')).toEqual(['tailnet-host']);
  });

  it('finds the private terms it is given, in any case, as literal strings', () => {
    const terms = ['examplelab', 'a.b+c'];
    const found = (text) => scanLine('docs/a.md', text, terms);
    expect(found('ssh examplelab-dev-01')).toEqual([{ rule: 'private-term', match: 'examplelab' }]);
    expect(found('https://kept.ExampleLab.dev')).toEqual([
      { rule: 'private-term', match: 'ExampleLab' },
    ]);
    expect(found('the a.b+c project')).toEqual([{ rule: 'private-term', match: 'a.b+c' }]);
    expect(found('the aXbbc project')).toEqual([]);
    expect(rules('docs/a.md', 'ssh examplelab-dev-01')).toEqual([]);
  });

  it('finds a private IPv4 address outside the allowlist', () => {
    for (const addr of ['10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.50.7', '100.101.2.3']) {
      expect(scanLine('docs/a.md', `host ${addr}:8080`)).toEqual([
        { rule: 'private-ipv4', match: addr },
      ]);
    }
  });

  it('leaves public, documentation and non-address numbers alone', () => {
    for (const text of [
      '8.8.8.8',
      '172.32.0.1',
      '172.15.0.1',
      '100.63.0.1',
      '100.128.0.1',
      '192.0.2.10',
      '198.51.100.7',
      'version 1.10.0.5',
      '10.0.0.5.1',
      '10.300.1.1',
      '192.168.1',
    ]) {
      expect(rules('docs/a.md', text)).toEqual([]);
    }
  });

  it('allows private addresses in tests, fixtures, mocks and listed files', () => {
    expect(privateIpv4Allowed('apps/server/src/net/ssrf.test.ts')).toBe(true);
    expect(privateIpv4Allowed('apps/web/src/api/mock/fixtures.ts')).toBe(true);
    expect(privateIpv4Allowed('apps/server/test/fixtures/x.json')).toBe(true);
    expect(privateIpv4Allowed('compose.yaml')).toBe(true);
    expect(privateIpv4Allowed('docs/new-page.md')).toBe(false);
    expect(rules('apps/server/src/net/ssrf.test.ts', "['192.168.1.1', true]")).toEqual([]);
  });

  it('applies every other rule inside allowed files too', () => {
    expect(rules('apps/server/src/x.test.ts', '/Users/someone/x')).toEqual(['home-directory']);
  });
});

describe('loadPrivateTerms', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-private-terms-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is empty without the file or the variable', () => {
    expect(loadPrivateTerms(dir, {})).toEqual([]);
  });

  it('reads the file, skipping blanks and comments, and adds the variable', () => {
    writeFileSync(
      path.join(dir, '.private-terms'),
      '# my machines\nexamplelab\n\n  other-project  # a comment\r\nexamplelab\n',
    );
    expect(loadPrivateTerms(dir, { KEPT_PRIVATE_TERMS: ' extra , ,other-project' })).toEqual([
      'examplelab',
      'other-project',
      'extra',
    ]);
  });
});

describe('the script over a repository', () => {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'check-no-local-paths.mjs',
  );
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-local-paths-'));
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(
      path.join(dir, 'docs/clean.md'),
      'Kept on 192.0.2.10 and <machine>.<tailnet>.ts.net\n',
    );
    writeFileSync(path.join(dir, 'docs/leak.md'), 'one\nthe ingress is 192.168.77.21\n');
    writeFileSync(path.join(dir, 'untracked.md'), '/Users/someone/x\n');
    git('add', 'docs');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports tracked findings with file and line, and ignores untracked files', () => {
    expect(findLeaks(dir)).toEqual([
      { file: 'docs/leak.md', line: 2, rule: 'private-ipv4', match: '192.168.77.21' },
    ]);
  });

  it('is clean on a clean tree', () => {
    git('rm', '-q', '--cached', 'docs/leak.md');
    expect(findLeaks(dir)).toEqual([]);
    git('add', 'docs/leak.md');
  });

  it('finds the private terms of an untracked .private-terms file in tracked files', () => {
    writeFileSync(path.join(dir, 'docs/term.md'), 'deployed on examplelab-dev-01\n');
    git('add', 'docs/term.md');
    writeFileSync(path.join(dir, '.private-terms'), 'examplelab\n');
    try {
      expect(findLeaks(dir)).toEqual([
        { file: 'docs/leak.md', line: 2, rule: 'private-ipv4', match: '192.168.77.21' },
        { file: 'docs/term.md', line: 1, rule: 'private-term', match: 'examplelab' },
      ]);
      // A tree without the file (a fork, CI) runs the generic rules only.
      expect(findLeaks(dir, [])).toEqual([
        { file: 'docs/leak.md', line: 2, rule: 'private-ipv4', match: '192.168.77.21' },
      ]);
    } finally {
      rmSync(path.join(dir, '.private-terms'));
      git('rm', '-q', '-f', 'docs/term.md');
    }
  });

  it('exits 1 and names file, line, rule and value', () => {
    const r = spawnSync('node', [script], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/leak.md:2: private-ipv4: 192.168.77.21');
  });
});
