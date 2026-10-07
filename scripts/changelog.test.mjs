import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify, HEADER, insertSection, renderSection } from './changelog.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'changelog.mjs');

describe('classify', () => {
  it('groups conventional subjects and hides the ones nobody running Kept sees', () => {
    expect(classify({ hash: 'a', subject: 'feat(web): a lock' })).toMatchObject({
      group: 'feat',
      scope: 'web',
      subject: 'a lock',
    });
    expect(classify({ hash: 'a', subject: 'fix: a crash' })).toMatchObject({
      group: 'fix',
      scope: null,
    });
    expect(classify({ hash: 'a', subject: 'i18n(web): plurals' })).toMatchObject({ group: 'i18n' });
    expect(classify({ hash: 'a', subject: 'test(web): more' })).toBeNull();
    expect(classify({ hash: 'a', subject: 'chore: bump' })).toBeNull();
  });

  it('marks `!` and a BREAKING CHANGE footer as breaking, even on a hidden type', () => {
    expect(classify({ hash: 'a', subject: 'feat(api)!: drop v0' }).group).toBe('breaking');
    expect(
      classify({
        hash: 'a',
        subject: 'refactor: env',
        body: 'x\n\nBREAKING CHANGE: KEPT_X is gone',
      }).group,
    ).toBe('breaking');
  });

  it('lists a subject that is not conventional under Other, whole', () => {
    expect(classify({ hash: 'a', subject: 'Merge the spike' })).toMatchObject({
      group: 'other',
      subject: 'Merge the spike',
    });
  });
});

describe('renderSection and insertSection', () => {
  it('puts a new section above the newest, under the header', () => {
    const one = renderSection('1.0.0', '2026-10-01', [
      { hash: '1111111aaa', subject: 'feat: one' },
    ]);
    const two = renderSection('1.1.0', '2026-10-07', [{ hash: '2222222bbb', subject: 'fix: two' }]);
    const text = insertSection(insertSection('', one), two);
    expect(text.startsWith(HEADER)).toBe(true);
    expect(text.indexOf('## 1.1.0')).toBeLessThan(text.indexOf('## 1.0.0'));
    expect(text).toContain('### Fixes\n\n- two (2222222)');
  });

  it('says so when nothing user-facing changed', () => {
    expect(
      renderSection('1.0.1', '2026-10-07', [{ hash: 'abcdef01', subject: 'test: x' }]),
    ).toContain('No user-facing changes.');
  });
});

describe('changelog.mjs over a fixture history', () => {
  let dir;
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@kept.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@kept.invalid',
      },
    });
  const commit = (subject, body = '') => {
    git('commit', '--allow-empty', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-changelog-'));
    git('init', '-q', '-b', 'main');
    commit('feat: before the last release');
    git('tag', 'v0.9.0');
    commit('feat(backup): restic snapshots');
    commit('fix(web): the lock screen in Arabic');
    commit('refactor(config)!: KEPT_BACKUP_KEEP is the daily count');
    commit('docs: the restore runbook');
    commit('test(server): more digests');
    commit('Tidy the spike folder');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the section since the tag, grouped, into CHANGELOG.md', () => {
    const file = path.join(dir, 'CHANGELOG.md');
    writeFileSync(file, `${HEADER}\n## 0.9.0 (2026-09-01)\n\n### Features\n\n- old (0000000)\n`);
    execFileSync(
      'node',
      [script, '--version', '1.0.0', '--from', 'v0.9.0', '--date', '2026-10-07', '--write', file],
      { cwd: dir },
    );
    const text = readFileSync(file, 'utf8');
    const section = text.slice(text.indexOf('## 1.0.0'), text.indexOf('## 0.9.0'));
    expect(section).toMatch(
      /### Breaking changes\n\n- \*\*config:\*\* KEPT_BACKUP_KEEP is the daily count/,
    );
    expect(section).toMatch(/### Features\n\n- \*\*backup:\*\* restic snapshots \([0-9a-f]{7}\)/);
    expect(section).toMatch(/### Fixes\n\n- \*\*web:\*\* the lock screen in Arabic/);
    expect(section).toMatch(/### Documentation\n\n- the restore runbook/);
    expect(section).toMatch(/### Other\n\n- Tidy the spike folder/);
    expect(section).not.toContain('more digests');
    expect(section).not.toContain('before the last release');
    // A second run for the same version refuses rather than duplicating it.
    expect(() =>
      execFileSync('node', [script, '--version', '1.0.0', '--from', 'v0.9.0', '--write', file], {
        cwd: dir,
        stdio: 'pipe',
      }),
    ).toThrow(/already has a 1.0.0 section/);
  });
});
