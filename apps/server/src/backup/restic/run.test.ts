import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupSummary, messagesOf, splitLines } from './json.js';
import { ResticError, type ResticRepo } from './restic.js';
import { ResticCli } from './run.js';

// The real wrapper's own promises (step-8 plan T5), against stand-in restic scripts that print
// what restic 0.19.1 printed in the R1 spike (docs/spikes/2026-10-06-step8-restic.md): exit codes,
// `exit_error` on stderr after plain-text warnings, summaries with zero fields left out, exit 3
// with a snapshot written, an endpoint that never answers. The real binary runs the shared
// contract in restic.contract.test.ts under KEPT_TEST_RESTIC=1.

const PASSWORD = 'stand-in password, long';
let dir: string;
const repo: ResticRepo = {
  location: '/nowhere/restic',
  env: { RESTIC_PASSWORD: PASSWORD },
  description: 'directory /nowhere',
};

/** A stand-in restic: a shell script with `body`. */
async function script(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const SUMMARY =
  '{"message_type":"summary","files_new":2,"data_added":2298,"total_files_processed":2,"total_bytes_processed":6,"snapshot_id":"c6d2543f7d3bd737fa933e76941173cb33d10114ca730e418e4b9de8940421b3"}';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-restic-run-'));
  await mkdir(path.join(dir, 'data'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('ResticCli', () => {
  it.each([
    [10, 'no_repository', 'Fatal: repository does not exist: unable to open config file'],
    [11, 'locked', 'Fatal: unable to create lock in backend: repository is already locked'],
    [12, 'wrong_password', 'Fatal: wrong password or no key found'],
    [1, 'failed', 'Fatal: Stat: Access Denied'],
  ])(
    'maps exit %i to %s, reading exit_error after plain-text warnings',
    async (code, reason, message) => {
      const bin = await script(
        `exit-${code}.sh`,
        `echo 'subprocess ssh: a warning, not JSON' >&2\nprintf '{"message_type":"exit_error","code":${code},"message":"${message}"}\\n' >&2\nexit ${code}`,
      );
      const err = await new ResticCli({ bin }).snapshots(repo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResticError);
      expect(err).toMatchObject({ reason, exitCode: code });
      expect((err as Error).message).toContain(message);
    },
  );

  it("init checks for a repository first and creates one only on exit 10 (init would make a typo'd bucket)", async () => {
    const log = path.join(dir, 'init.log');
    const bin = await script(
      'init.sh',
      `echo "$1 $2 $3" >> ${log}\ncase "$2" in\n  cat) printf '{"message_type":"exit_error","code":10,"message":"no repo"}\\n' >&2; exit 10;;\n  init) echo '{"message_type":"initialized","id":"x","repository":"r"}'; exit 0;;\nesac\nexit 1`,
    );
    expect(await new ResticCli({ bin }).init(repo)).toEqual({ created: true });
    const exists = await script('exists.sh', `echo '{"version":2,"id":"abc"}'`);
    expect(await new ResticCli({ bin: exists }).init(repo)).toEqual({ created: false });
  });

  it('reads a summary whose zero fields restic left out', () => {
    const [summary] = messagesOf(splitLines(SUMMARY).messages, 'summary', BackupSummary);
    expect(summary).toMatchObject({ files_new: 2, files_changed: 0, files_unmodified: 0 });
  });

  it('exit 3 is `partial`, with the snapshot it still wrote and the files it could not read', async () => {
    const bin = await script(
      'partial.sh',
      `echo '{"message_type":"status","percent_done":0.5}'\necho '{"message_type":"error","error":{"message":"open: permission denied"},"during":"archival","item":"/data/blobs/f/x"}'\necho '${SUMMARY}'\nexit 3`,
    );
    const err = await new ResticCli({ bin })
      .backup(repo, { paths: ['blobs'], cwd: path.join(dir, 'data'), tags: ['kept'] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'partial', exitCode: 3 });
    expect((err as ResticError).partial).toMatchObject({
      unreadable: 1,
      summary: { snapshotId: expect.stringMatching(/^c6d2543f/), filesNew: 2, filesChanged: 0 },
    });
  });

  it('a malformed message fails the command; one it does not know is ignored', async () => {
    const odd = await script(
      'odd.sh',
      `echo '{"message_type":"something_new"}'\necho '{"message_type":"summary","snapshot_id":"not hex"}'`,
    );
    await expect(
      new ResticCli({ bin: odd }).backup(repo, { paths: ['x'], tags: ['kept'] }),
    ).rejects.toMatchObject({ reason: 'failed' });
  });

  it('kills a command that never answers and reports the target unreachable', async () => {
    const bin = await script('hang.sh', 'echo "retrying after 1.27s" >&2\nexec sleep 30');
    const started = Date.now();
    const err = await new ResticCli({ bin, timeouts: { quick: 300 } })
      .snapshots(repo)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('forgets with the policy, grouped as asked, pruning in the same command (prune alone prints text)', async () => {
    const log = path.join(dir, 'forget.log');
    const bin = await script('forget.sh', `echo "$@" > ${log}\necho '[]'`);
    await new ResticCli({ bin }).forget(repo, {
      tags: ['kept', 'nightly'],
      keep: { daily: 7, weekly: 4, monthly: 6 },
      groupBy: ['host'],
      prune: true,
    });
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(log, 'utf8')).trim()).toBe(
      '--json forget --host kept --group-by host --tag kept,nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune',
    );
  });
});
