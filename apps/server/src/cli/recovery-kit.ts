import { open } from 'node:fs/promises';
import { KEPT_VERSION, RECOVERY_KIT_FORMATS, type RecoveryKitFormat } from '@kept/shared';
import { asOwner, CliError } from '../admin/cli.js';
import { audited } from '../audit/audited.js';
import { readBackupForKit } from '../backup/recovery-kit-source.js';
import { readKeyMaterial } from '../config/env.js';
import { fixedSecretKeys, keyringOfMaterial } from '../crypto/keyring.js';
import { recordRecoveryKitDownload } from '../setup/recovery-kit.js';
import {
  type KitBackupHalf,
  kitKeysOf,
  type RecoveryKitInput,
  renderRecoveryKit,
} from '../setup/recovery-kit-content.js';

// `kept admin recovery-kit [--format text|html] [--out <file>]` (D165, D182; step-8 T9). The keys
// come from the environment or the config volume, as the server reads them (readKeyMaterial), so
// the kit prints even with the database down. With the database owner's login
// (KEPT_OWNER_DATABASE_URL) it also holds the backup half (backup/recovery-kit-source.ts), and
// the print is recorded as a download (audited `instance.recovery_kit_download` as `system`),
// which clears the status page's "download it again". Without it, the kit says the backup half
// is missing and how to include it.
//
// Standard output by default; `--out` writes a file readable by its owner only (0600, also when
// it existed). Nothing of the kit goes to stderr, a log line or an error message.

type Source = Record<string, string | undefined>;

export type RecoveryKitCommandOptions = { format?: string; out?: string };

function formatOf(value: string | undefined): RecoveryKitFormat {
  const format = value ?? 'text';
  if (!(RECOVERY_KIT_FORMATS as readonly string[]).includes(format)) {
    throw new CliError(`--format takes ${RECOVERY_KIT_FORMATS.join(' or ')}`);
  }
  return format as RecoveryKitFormat;
}

/** Writes `content` to `file`, readable and writable by its owner only. */
async function writePrivate(file: string, content: string): Promise<void> {
  const handle = await open(file, 'w', 0o600);
  try {
    // An existing file keeps its mode through open(); the kit must not stay world-readable.
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

export async function recoveryKitCommand(
  source: Source,
  opts: RecoveryKitCommandOptions,
  out: { write: (text: string) => void; warn: (line: string) => void },
): Promise<number> {
  const format = formatOf(opts.format);
  const material = await readKeyMaterial(source);
  const ownerUrl = source.KEPT_OWNER_DATABASE_URL?.trim();

  let backup: KitBackupHalf = {
    state: 'unavailable',
    reason: "the database owner's login (KEPT_OWNER_DATABASE_URL) isn't set here.",
  };
  if (ownerUrl) {
    const quiet = { send: async () => {} };
    try {
      backup = await asOwner(ownerUrl, quiet, async (client, tx) => {
        const half = await readBackupForKit({
          client,
          env: source,
          secretKeys: fixedSecretKeys(keyringOfMaterial(material)),
        });
        await recordRecoveryKitDownload(client);
        await audited(tx, {
          locationId: null,
          ownerAccountId: null,
          actor: { type: 'system', id: null },
          action: 'instance.recovery_kit_download',
          entity: { type: 'instance_settings', id: null },
          after: { format, via: 'cli' },
        });
        return { result: half, mail: [] };
      });
    } catch (err) {
      // The keys still print: they matter most when the database is the thing that broke.
      const code = (err as { code?: unknown }).code;
      out.warn(
        `kept admin recovery-kit: the database didn't answer${typeof code === 'string' ? ` (${code})` : ''}; the kit holds the keys but not the backup settings.`,
      );
      backup = { state: 'unavailable', reason: "the database didn't answer when it was made." };
    }
  }

  const kit: RecoveryKitInput = {
    generatedAt: new Date(),
    publicUrl: source.KEPT_PUBLIC_URL?.trim() || null,
    version: KEPT_VERSION,
    revision: source.KEPT_REVISION?.trim() || null,
    keys: kitKeysOf(material),
    backup,
  };
  const content = renderRecoveryKit(kit, format);
  if (opts.out) {
    await writePrivate(opts.out, content);
    out.warn(
      `Wrote the recovery kit to ${opts.out} (readable by you only). Keep it off this server.`,
    );
  } else {
    out.write(content);
  }
  return 0;
}
