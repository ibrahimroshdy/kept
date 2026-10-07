import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compare, imageTags, newest, refusal, unsignedRefusal } from './release/version.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));

describe('versions and tags', () => {
  it('orders by semver precedence, prereleases before their release', () => {
    expect(compare('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compare('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compare('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(newest(['v1.0.0', 'v1.2.0-rc.1', 'v1.1.5', 'not-a-tag'])).toBe('1.2.0-rc.1');
  });

  it('refuses a malformed version and one not newer than the last tag', () => {
    expect(refusal('v1.0.0', [])).toMatch(/not a release version/);
    expect(refusal('1.0.0+build.1', [])).toMatch(/not a release version/);
    expect(refusal('1.0', [])).toMatch(/not a release version/);
    expect(refusal('1.1.0', ['v1.2.0'])).toBe('1.1.0 is not newer than v1.2.0');
    expect(refusal('1.2.0', ['v1.2.0'])).toMatch(/not newer/);
    expect(refusal('1.2.0', ['v1.2.0-rc.1'])).toBeNull();
    expect(refusal('0.1.0', [])).toBeNull();
  });

  it('tags X.Y and X only for the newest final release of each line; never latest', () => {
    expect(imageTags('1.0.0', [])).toEqual(['1.0.0', '1.0', '1']);
    expect(imageTags('1.2.3', ['v1.2.2', 'v1.1.0'])).toEqual(['1.2.3', '1.2', '1']);
    expect(imageTags('1.1.4', ['v1.2.0', 'v1.1.3'])).toEqual(['1.1.4', '1.1']);
    expect(imageTags('1.0.0-rc.1', [])).toEqual(['1.0.0-rc.1']);
    expect(imageTags('2.0.0', ['v3.0.0-rc.1', 'v1.9.0'])).toEqual(['2.0.0', '2.0', '2']);
    for (const tags of [imageTags('1.0.0', []), imageTags('9.9.9', ['v1.0.0'])]) {
      expect(tags).not.toContain('latest');
    }
  });

  it('allows an unsigned release below 1.0.0 and for prereleases only', () => {
    expect(unsignedRefusal('0.9.0')).toBeNull();
    expect(unsignedRefusal('0.9.1-rc.1')).toBeNull();
    expect(unsignedRefusal('1.0.0-rc.1')).toBeNull();
    expect(unsignedRefusal('1.0.0')).toMatch(/1\.0\.0 must be signed/);
    expect(unsignedRefusal('1.2.3')).toMatch(/must be signed/);
    expect(unsignedRefusal('2.0.0')).toMatch(/must be signed/);
    expect(unsignedRefusal('v0.9.0')).toMatch(/not a version/);
  });
});

// release.sh's preconditions, in a scratch repository holding a copy of the scripts. Each case
// fails before anything needs Docker, cosign or Helm.
describe('release.sh refuses', () => {
  let dir;
  const {
    KEPT_COSIGN_KEY: _key,
    COSIGN_PASSWORD: _password,
    KEPT_RELEASE_UNSIGNED: _unsigned,
    KEPT_RELEASE_REGISTRY: _registry,
    // The ci workflow runs these tests inside GitHub Actions: each test that wants it sets it.
    GITHUB_ACTIONS: _actions,
    ...inherited
  } = process.env;
  const env = {
    ...inherited,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@kept.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@kept.invalid',
    KEPT_RELEASE_MIN_FREE_GB: '0',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const release = (...args) => releaseWith({}, ...args);
  const releaseWith = (extra, ...args) => {
    const r = spawnSync('bash', ['scripts/release.sh', ...args], {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // A passing gate record for HEAD, so a run reaches the checks after the gate.
  const passGate = (version) => {
    const gate = path.join(dir, `.tmp/release/${version}/gate.txt`);
    mkdirSync(path.dirname(gate), { recursive: true });
    writeFileSync(gate, `commit=${git('rev-parse', 'HEAD').trim()}\nexit=0\n`);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-release-'));
    mkdirSync(path.join(dir, 'scripts'));
    for (const f of [
      'release.sh',
      'tools.sh',
      'changelog.mjs',
      'check-attribution.sh',
      'release',
    ]) {
      cpSync(path.join(scripts, f), path.join(dir, 'scripts', f), { recursive: true });
    }
    writeFileSync(path.join(dir, '.gitignore'), '.tmp/\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: the scripts');
    git('tag', 'v1.2.0');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("release.yml's split outside the workflow, or used wrongly", () => {
    let r = release('1.3.0', '--arch', 'amd64');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--arch and --publish are release.yml's split of --ci");

    const ci = { GITHUB_ACTIONS: 'true' };
    r = releaseWith(ci, '1.3.0', '--ci', '--arch', 'riscv64');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--arch is amd64 or arm64, not 'riscv64'");

    r = releaseWith(ci, '1.3.0', '--ci', '--arch', 'arm64', '--publish');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('one or the other');
  });

  it('a dirty tree', () => {
    writeFileSync(path.join(dir, 'stray.txt'), 'x');
    const r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the working tree is not clean');
  });

  it('a version that is not newer than the last tag', () => {
    const r = release('1.1.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('1.1.0 is not newer than v1.2.0');
  });

  it('a branch other than main', () => {
    git('switch', '-q', '-c', 'topic');
    const r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("HEAD is on 'topic'");
  });

  it('a missing gate record, and one for another commit or a failed run', () => {
    let r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no gate record for 1.3.0');

    const gate = path.join(dir, '.tmp/release/1.3.0/gate.txt');
    mkdirSync(path.dirname(gate), { recursive: true });
    writeFileSync(gate, 'commit=0000000000000000000000000000000000000000\nexit=0\n');
    r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('is not a pass for');

    writeFileSync(gate, `commit=${git('rev-parse', 'HEAD').trim()}\nexit=1\n`);
    r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('is not a pass for');
  });

  it('--ci outside GitHub Actions, or mixed with another mode', () => {
    let r = release('1.3.0', '--ci');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('--ci is for .github/workflows/release.yml');
    r = release('1.3.0', '--ci', '--dry-run');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no --dry-run, no --run-gate');
  });

  it('--ci without the tag at HEAD, or with its commit off main', () => {
    const ci = (...args) => {
      const r = spawnSync('bash', ['scripts/release.sh', ...args], {
        cwd: dir,
        env: { ...env, GITHUB_ACTIONS: 'true' },
        encoding: 'utf8',
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    let r = ci('1.3.0', '--ci');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no tag v1.3.0');

    git('tag', 'v1.3.0');
    writeFileSync(path.join(dir, 'later.txt'), 'x');
    git('add', 'later.txt');
    git('commit', '-q', '-m', 'feat: later');
    r = ci('1.3.0', '--ci');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('is not the commit tag v1.3.0 names');

    // At the tag, but no origin/main holds it.
    git('switch', '-q', '--detach', 'v1.3.0');
    r = ci('1.3.0', '--ci');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('is not on origin/main');
  });

  it('a signed release without its key, its password or cosign.pub', () => {
    passGate('1.3.0');
    let r = release('1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('KEPT_COSIGN_KEY must name the cosign private key file');

    const key = path.join(dir, '.tmp/cosign.key');
    writeFileSync(key, 'not a real key');
    r = releaseWith({ KEPT_COSIGN_KEY: key }, '1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('COSIGN_PASSWORD must be set');

    r = releaseWith({ KEPT_COSIGN_KEY: key, COSIGN_PASSWORD: '' }, '1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('cosign.pub is not committed');
  });

  it('an unsigned release of 1.0.0 or later, or a KEPT_RELEASE_UNSIGNED that is not 1', () => {
    passGate('1.3.0');
    let r = releaseWith({ KEPT_RELEASE_UNSIGNED: '1' }, '1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('1.3.0 must be signed');
    expect(r.out).not.toContain('UNSIGNED release');

    r = releaseWith({ KEPT_RELEASE_UNSIGNED: 'yes' }, '1.3.0');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("KEPT_RELEASE_UNSIGNED is 1 or unset, not 'yes'");
  });

  it('but lets 0.9.0 go out unsigned with no key, password or cosign.pub', () => {
    git('tag', '-d', 'v1.2.0');
    passGate('0.9.0');
    // An invalid registry and an empty tools directory: the run must stop before anything leaves
    // the machine, whatever docker or helm this machine has.
    const tools = path.join(dir, '.tmp/no-tools');
    mkdirSync(tools, { recursive: true });
    const r = releaseWith(
      {
        KEPT_RELEASE_UNSIGNED: '1',
        KEPT_RELEASE_REGISTRY: 'NOT/A/REGISTRY',
        KEPT_TOOLS_DIR: tools,
      },
      '0.9.0',
    );
    expect(r.out).toContain('UNSIGNED release (KEPT_RELEASE_UNSIGNED=1)');
    expect(r.out).not.toContain('must be signed');
    expect(r.out).not.toContain('KEPT_COSIGN_KEY');
    expect(r.out).not.toContain('COSIGN_PASSWORD');
    expect(r.out).not.toContain('cosign.pub');
    // Past the key checks; an unsigned release needs no cosign binary either. It stops at docker,
    // helm or the registry path, all before any build or push.
    expect(r.out).not.toMatch(/cosign v[\d.]+ not found/);
    expect(r.out).toMatch(/docker is not on PATH|helm v[\d.]+ not found|is not an image path/);
    expect(r.status).not.toBe(0);
  });

  it('a dry run aimed at a real registry', () => {
    const r = release('1.3.0', '--dry-run', '--registry', 'ghcr.io/someone/kept');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('takes no --registry');
  });
});

describe("the chart stage (release/chart.sh, plan Q17: the chart's version is the release's)", () => {
  let dir;
  const repoRoot = path.dirname(scripts);
  const digest = `sha256:${'a'.repeat(64)}`;
  // A stand-in helm: logs its arguments, answers `show` from $FAKE_PUBLISHED (exit 0 = the chart
  // version is already published), writes the archive `package` names, renders the pinned image
  // and prints a push digest.
  const fakeHelm = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
case $1 in
  show) [[ -n \${FAKE_PUBLISHED:-} ]] ;;
  package)
    while (($#)); do case $1 in --version) v=$2 ;; --destination) d=$2 ;; esac; shift; done
    : >"$d/kept-$v.tgz" ;;
  template) echo "        image: $FAKE_IMAGE" ;;
  push) echo "Digest: ${digest}" ;;
esac
`;
  const runChart = (extra = {}) => {
    const work = path.join(dir, 'work');
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
say() { echo "$*"; }; note() { echo "$*"; }; die() { echo "$*" >&2; exit 1; }
source "$1"
release_chart
echo "chart_ref=$chart_ref chart_digest=$chart_digest"`,
        'chart-test',
        path.join(scripts, 'release/chart.sh'),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_LOG: path.join(dir, 'helm.log'),
          FAKE_IMAGE: `ghcr.io/someone/kept:1.3.0@${digest}`,
          ...extra,
        },
      },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}`, work };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kept-chart-'));
    const work = path.join(dir, 'work');
    cpSync(path.join(repoRoot, 'charts/kept'), path.join(work, 'src/charts/kept'), {
      recursive: true,
    });
    writeFileSync(path.join(dir, 'helm'), fakeHelm, { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The shell variables release.sh sets before it sources chart.sh, passed through the
  // environment (bash reads each as a variable). Unsigned, so nothing calls cosign.
  const withVars = (d, extra = {}) => ({
    work: path.join(d, 'work'),
    helm: path.join(d, 'helm'),
    version: '1.3.0',
    registry: 'ghcr.io/someone/kept',
    chart_repo: 'ghcr.io/someone/charts',
    index_digest: digest,
    http_registry: '',
    dry: '',
    unsigned: '1',
    ...extra,
  });

  it('packages the chart as version X.Y.Z with appVersion X.Y.Z, leaving Chart.yaml alone', () => {
    const r = runChart(withVars(dir));
    expect(r.out).toContain('chart_ref=ghcr.io/someone/charts/kept:1.3.0');
    expect(r.status).toBe(0);
    const log = execFileSync('cat', [path.join(dir, 'helm.log')], { encoding: 'utf8' });
    expect(log).toMatch(/^show chart oci:\/\/ghcr\.io\/someone\/charts\/kept --version 1\.3\.0$/m);
    expect(log).toMatch(/^package .* --version 1\.3\.0 --app-version 1\.3\.0 /m);
    const chartYaml = execFileSync(
      'sed',
      ['-n', 's/^version: *//p', path.join(r.work, 'src/charts/kept/Chart.yaml')],
      { encoding: 'utf8' },
    );
    expect(chartYaml.trim()).toBe('0.0.0-dev');
  });

  it('refuses a chart version already published, before it packages anything', () => {
    const r = runChart(withVars(dir, { FAKE_PUBLISHED: '1' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('chart 1.3.0 is already published at ghcr.io/someone/charts/kept');
    const log = execFileSync('cat', [path.join(dir, 'helm.log')], { encoding: 'utf8' });
    expect(log).not.toMatch(/^package /m);
  });
});
