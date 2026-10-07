import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { CliError } from '../admin/cli.js';
import { audited } from '../audit/audited.js';
import { loadAdminEnv, readKeyMaterial } from '../config/env.js';
import {
  keyringOfMaterial,
  replaceSecretsFile,
  retiredVersions as retiredOf,
  rotatedMaterial,
  withoutRetired,
} from '../crypto/keyring.js';
import * as schema from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import {
  CIPHERTEXTS,
  type RotationReport,
  rotateCiphertexts,
  type SealedColumn,
  versionsInUse,
} from '../secrets/rotate.js';
import { markRecoveryKitStale } from '../setup/recovery-kit.js';

// `kept admin rotate-key [--new-key <key>] [--resume]` (engineering spec §7.3, D182; plan T19,
// Q19). As kept_owner, beside the keys the server uses (the environment, or the config volume's
// secrets.json; never generated here).
//
// With keys in secrets.json (generated on first boot, D193):
//   1. checks every key version the stored values use is in the keyring (else it stops: a value
//      whose key is missing would be lost for good by a rotation that "succeeded");
//   2. makes the new key (given, or generated) the current one at the next version, keeping the
//      old one under the retired keys, and writes secrets.json FIRST, atomically: if the run
//      stops after this, every value still opens with the new file;
//   3. re-wraps every stored value to the new version, in batches of 500, one transaction each;
//   4. audits `instance.rotate_key` as system, and says to save a new recovery kit.
//   A running server picks the new file up the first time it meets the new version (keyring.ts
//   refresh()); restart it to seal new values with the new key.
//
// With keys in the environment, it can't write the new key anywhere the server reads, so it
// prints the three variables to set and changes nothing; after they are set and the server
// restarted, `--resume` does step 3.
//
// `--resume` re-wraps whatever isn't under the current version yet: an interrupted run, values a
// server sealed with its old key meanwhile, or rows restored from an old backup.
//
// Every run prints the key versions the stored values use, before and after (security review
// #17), so an operator knows which retired keys still matter. `--drop <version>` removes one
// retired version from the keyring, and refuses while any stored value still uses it (a value
// whose key is gone is lost for good); it warns that backups sealed under it will no longer
// open, and audits `instance.drop_key`. With keys in the environment it prints the
// KEPT_SECRET_KEYS_RETIRED to set instead.

export type RotateKeyOptions = {
  newKey?: string;
  resume?: boolean;
  /** A retired key version to remove from the keyring (nothing is rotated). */
  drop?: number;
  columns?: readonly SealedColumn[];
  batchSize?: number;
};

type Source = Record<string, string | undefined>;

const retiredVersions = (retired: string | undefined) =>
  (retired ?? '')
    .split(',')
    .filter((x) => x.trim() !== '')
    .map((x) => x.trim().split(':')[0])
    .join(', ');

function describe(report: RotationReport, print: (line: string) => void): number {
  let failed = 0;
  for (const c of report.columns) {
    print(`  ${c.name}: ${c.rewrapped} re-wrapped to version ${report.version}`);
    for (const f of c.failed) print(`    could not re-wrap ${f.id} (${f.reason})`);
    failed += c.failed.length;
  }
  return failed;
}

/** `1 (5 values), 2 (1 value)`, or `none`. */
function inUseLine(inUse: ReadonlyMap<number, number>): string {
  const parts = [...inUse]
    .sort(([a], [b]) => a - b)
    .map(([v, n]) => `${v} (${n} value${n === 1 ? '' : 's'})`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

async function audit(
  client: pg.Client,
  action: 'instance.rotate_key' | 'instance.drop_key',
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  await client.query('BEGIN');
  try {
    await audited(drizzle(client, { schema }) as unknown as Tx, {
      locationId: null,
      ownerAccountId: null,
      actor: { type: 'system', id: null },
      action,
      entity: { type: 'instance', id: null },
      before,
      after,
    });
    // A kit downloaded before a rotation lacks the new key (and, after --resume under an
    // environment-set key, the one now current): the status page asks for a new one (T9).
    if (action === 'instance.rotate_key') await markRecoveryKitStale(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Runs the command; returns the process exit code (1 when a value could not be re-wrapped). */
export async function rotateKey(
  source: Source,
  opts: RotateKeyOptions,
  print: (line: string) => void,
): Promise<number> {
  const { ownerUrl } = loadAdminEnv(source);
  const material = await readKeyMaterial(source);
  const ring = keyringOfMaterial(material);
  const columns = opts.columns ?? CIPHERTEXTS;

  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'kept-admin' });
  // A backend ended under it emits 'error'; unhandled, that ends the process instead of failing
  // the command's next statement.
  client.on('error', () => {});
  await client.connect();
  try {
    const inUse = await versionsInUse(client, columns);
    const missing = [...inUse.keys()].filter((v) => !ring.keyring.has(v)).sort((a, b) => a - b);
    if (missing.length > 0) {
      throw new CliError(
        `stored values use key version ${missing.join(', ')}, which this keyring lacks; add ${missing.length > 1 ? 'them' : 'it'} to KEPT_SECRET_KEYS_RETIRED (from the recovery kit) first`,
      );
    }
    const before = [...inUse.keys()].sort((a, b) => a - b);

    if (opts.drop !== undefined) {
      const version = opts.drop;
      if (version === ring.current.keyVersion) {
        throw new CliError(`key version ${version} is the current key; rotate first, then drop it`);
      }
      if (!retiredOf(material).includes(version)) {
        throw new CliError(`there is no retired key version ${version} in this keyring`);
      }
      const using = inUse.get(version) ?? 0;
      if (using > 0) {
        throw new CliError(
          `key version ${version} still opens ${using} stored value${using === 1 ? '' : 's'}; run \`kept admin rotate-key --resume\` to re-wrap ${using === 1 ? 'it' : 'them'}, then drop it`,
        );
      }
      const next = withoutRetired(material, version);
      print(`Key versions in use: ${inUseLine(inUse)}`);
      if (material.source === 'environment') {
        print('Your keys come from the environment, so nothing was changed. Set this:');
        print(`KEPT_SECRET_KEYS_RETIRED=${next.KEPT_SECRET_KEYS_RETIRED ?? ''}`);
      } else {
        await replaceSecretsFile(material.source, next);
        print(`Wrote ${material.source}: retired key version ${version} is gone.`);
      }
      print(
        `A backup made while version ${version} was in use no longer opens its secret values without it: keep it in an old recovery kit if you may restore one.`,
      );
      await audit(client, 'instance.drop_key', { dropped: null }, { dropped: version });
      return 0;
    }
    print(`Key versions in use before: ${inUseLine(inUse)}`);

    let target = ring;
    if (!opts.resume) {
      const next = rotatedMaterial(material, {
        ...(opts.newKey ? { newKey: opts.newKey } : {}),
        atLeast: Math.max(0, ...inUse.keys()),
      });
      if (material.source === 'environment') {
        print('Your keys come from the environment, so nothing was changed yet. Set these:');
        print(`KEPT_SECRET_KEY=${next.KEPT_SECRET_KEY}`);
        print(`KEPT_SECRET_KEY_VERSION=${next.KEPT_SECRET_KEY_VERSION}`);
        print(`KEPT_SECRET_KEYS_RETIRED=${next.KEPT_SECRET_KEYS_RETIRED}`);
        print(
          'then restart Kept, and run `kept admin rotate-key --resume` (with the same variables) to re-wrap the stored values. Keep these values in your recovery kit.',
        );
        return 0;
      }
      await replaceSecretsFile(material.source, next);
      print(
        `Wrote ${material.source}: key version ${next.KEPT_SECRET_KEY_VERSION} is current; version(s) ${retiredVersions(next.KEPT_SECRET_KEYS_RETIRED)} retired.`,
      );
      target = keyringOfMaterial(next);
    }

    const report = await rotateCiphertexts(client, target.keyring, target.current, {
      columns,
      ...(opts.batchSize ? { batchSize: opts.batchSize } : {}),
    });
    const failed = describe(report, print);
    const rewrapped = report.columns.reduce((n, c) => n + c.rewrapped, 0);
    const afterInUse = await versionsInUse(client, columns);
    const after = [...afterInUse.keys()].sort((a, b) => a - b);
    print(`Key versions in use after: ${inUseLine(afterInUse)}`);
    await audit(
      client,
      'instance.rotate_key',
      { key_versions: before, rewrapped: 0 },
      { key_versions: after, rewrapped },
    );
    if (!opts.resume) {
      print('Save a new recovery kit now (kept admin recovery-kit): it holds the new key and the');
      print('retired ones, which old backups still need. Restart Kept to seal with the new key.');
    }
    if (failed > 0) {
      print(`${failed} value(s) could not be re-wrapped; they were left as they were.`);
      return 1;
    }
    return 0;
  } finally {
    await client.end();
  }
}
