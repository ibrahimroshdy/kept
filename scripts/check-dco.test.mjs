import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-dco.sh');

describe('check-dco.sh over a fixture history', () => {
  let dir;
  const env = (name, email) => ({
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  });
  const git = (args, who = ['Talia', 'talia@kept.invalid']) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: env(...who) }).trim();
  const commit = (subject, extra = [], who) => {
    git(['commit', '--allow-empty', '-q', '-m', subject, ...extra], who);
    return git(['rev-parse', 'HEAD']);
  };
  const check = (range) =>
    spawnSync('bash', [script, '--range', range], { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-dco-'));
    git(['init', '-q', '-b', 'main']);
    commit('chore: the history before the DCO, unsigned');
    git(['tag', 'base']);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when every commit is signed off by its author', () => {
    commit('feat: one', ['-s']);
    commit('fix: two', ['-s']);
    const r = check('base..HEAD');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 commit(s) signed off');
  });

  it('fails on a commit without a sign-off and names it', () => {
    const sha = commit('docs: unsigned');
    const r = check('base..HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(sha.slice(0, 12));
    expect(r.stderr).toContain('Signed-off-by: Talia <talia@kept.invalid>');
    git(['reset', '-q', '--hard', 'HEAD~1']);
  });

  it("fails when the sign-off is someone else's", () => {
    commit('test: signed by another', ['-m', 'Signed-off-by: Louis <louis@kept.invalid>']);
    expect(check('base..HEAD').status).toBe(1);
    git(['reset', '-q', '--hard', 'HEAD~1']);
  });

  it('accepts a co-signed commit that includes its author, and skips merges', () => {
    commit('feat: pair work', [
      '-m',
      'Signed-off-by: Louis <louis@kept.invalid>\nSigned-off-by: Talia <talia@kept.invalid>',
    ]);
    git(['checkout', '-q', '-b', 'side', 'base']);
    commit('fix: on a branch', ['-s'], ['Bruce', 'bruce@kept.invalid']);
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-ff', '--no-edit', 'side']); // the merge commit itself is unsigned
    expect(check('base..HEAD').status).toBe(0);
  });

  it('passes on an empty range and refuses a missing one', () => {
    expect(check('HEAD..HEAD').status).toBe(0);
    expect(spawnSync('bash', [script], { cwd: dir }).status).toBe(2);
  });
});
