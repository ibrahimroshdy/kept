import { KEPT_VERSION } from '@kept/shared';
import { EnvError, readKeyMaterial } from '../config/env.js';
import type { Keyring } from '../crypto/envelope.js';
import { keyringOfMaterial } from '../crypto/keyring.js';
import type { PreUpgradeSnapshot } from '../db/migrate.js';
import { loadBackupCliEnv } from './config.js';
import { runSnapshot } from './nightly.js';
import { pgTools } from './pg-tools.js';
import {
  type BackupNotConfigured,
  isResolved,
  loadBackupSettings,
  type RawEnv,
  type ResolvedBackupSettings,
} from './settings.js';

// The pre-upgrade snapshot's settings side (step-8 plan T8, Q8): `kept migrate` reads the backup
// settings on its own owner connection, overlaid by the environment, and opens the sealed ones
// with the keys when the migrate container has them (T15 mounts the config volume read-only and
// passes the key variables). The snapshot itself is the backup engine's database-only run
// (backup/nightly.ts runSnapshot with `{kind: 'pre_upgrade', databaseOnly: true}`), passed in as
// `take`, so this file doesn't depend on how the engine is built.
//
// - No target, or no password: `no_target` (a loud line and a status-page note; a first install
//   has no backup yet, so never a refusal).
// - Saved settings whose secrets the keys can't open (no keys here): an error, so the migration
//   stops rather than silently upgrading without the backup the admin set up.

export type TakeDatabaseSnapshot = (
  settings: ResolvedBackupSettings,
  info: { fromVersion: string | null; toVersion: string },
) => Promise<void>;

export function preUpgradeSnapshot(opts: {
  raw: RawEnv;
  keyring: Keyring | null;
  take: TakeDatabaseSnapshot;
}): PreUpgradeSnapshot {
  return async ({ client, fromVersion, toVersion }) => {
    let settings: ResolvedBackupSettings | BackupNotConfigured;
    try {
      settings = await loadBackupSettings(client, opts.raw, opts.keyring);
    } catch (err) {
      // A sealed value the keys here can't open.
      throw new Error(
        `the backup settings could not be read: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
    if (!isResolved(settings)) {
      if (settings.reason === 'no_credentials') {
        throw new Error(
          'backups are set up in Admin → Backups, but this container has no keys to open their credentials: give `kept migrate` the keys (KEPT_CONFIG_DIR or KEPT_SECRET_KEY)',
        );
      }
      return 'no_target';
    }
    await opts.take(settings, { fromVersion, toVersion });
    return 'taken';
  };
}

/**
 * `kept migrate`'s snapshot: the keys when the container has them (else null: an
 * environment-only configuration still works), and the engine's database-only run, recorded as
 * a `pre_upgrade` backup run with both versions.
 */
export async function migratePreUpgradeSnapshot(
  raw: Readonly<Record<string, string | undefined>>,
): Promise<PreUpgradeSnapshot> {
  let keyring: Keyring | null = null;
  try {
    keyring = keyringOfMaterial(await readKeyMaterial(raw)).keyring;
  } catch (err) {
    if (!(err instanceof EnvError)) throw err;
  }
  return preUpgradeSnapshot({
    raw,
    keyring,
    take: async (settings, info) => {
      const env = await loadBackupCliEnv(raw);
      await runSnapshot(
        {
          ownerUrl: env.ownerUrl,
          restic: env.restic,
          settings,
          dataDir: env.dataDir,
          storage: env.storage,
          blobs: env.blobs,
          pgTools: pgTools(),
          version: KEPT_VERSION,
        },
        {
          kind: 'pre_upgrade',
          databaseOnly: true,
          fromVersion: info.fromVersion,
          toVersion: info.toVersion,
        },
      );
    },
  });
}
