#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { KEPT_VERSION } from '@kept/shared';
import { Command } from 'commander';
import pg from 'pg';
import {
  CliError,
  disableUserByLogin,
  enableUserByLogin,
  reissueSetupCode,
  resetPassword,
  transferOwnership,
} from '../admin/cli.js';
import { ExportError } from '../backup/export.js';
import { BackupError } from '../backup/nightly.js';
import { PgToolError } from '../backup/pg-tools.js';
import { migratePreUpgradeSnapshot } from '../backup/pre-upgrade.js';
import { RestoreError } from '../backup/restore.js';
import { EnvError, loadAdminEnv, loadEnv, loadMigrateEnv } from '../config/env.js';
import { renderEnvReference } from '../config/reference.js';
import { generateKey } from '../crypto/envelope.js';
import { secretKeysOf } from '../crypto/keyring.js';
import { runMigrations } from '../db/migrate.js';
import { closePools, createPools } from '../db/pools.js';
import { logMailer, type Mailer } from '../mail/mailer.js';
import { createMailer, profileLocaleLookup } from '../mail/transport.js';
import { formatSeedReport, SeedError } from '../seed/households.js';
import {
  assertSeedAllowed,
  runSeed,
  SCENARIOS,
  type Scenario,
  SeedRefused,
} from '../seed/index.js';
import { setupCodeLine } from '../setup/setup-code.js';
import { createFileStorage } from '../storage/create.js';
import { backfillPdfTextCommand } from './backfill-pdf-text.js';
import {
  backupCommand,
  backupDrillCommand,
  backupUnlockCommand,
  backupVerifyCommand,
} from './backup.js';
import { exportCommand } from './export.js';
import { readableCommand } from './readable.js';
import { recoveryKitCommand } from './recovery-kit.js';
import { restoreCommand } from './restore.js';
import { rotateKey } from './rotate-key.js';
import { storageCopyCommand, storageVerifyCommand } from './storage.js';

const stderrLog = {
  warn: (obj: object, msg?: string) => {
    process.stderr.write(`${JSON.stringify({ ...obj, msg })}\n`);
  },
} as Parameters<typeof logMailer>[0];

/** The notices a command sends (D180): over SMTP when KEPT_SMTP_URL and KEPT_PUBLIC_URL are set
 * beside the owner login, in each person's language; otherwise said on stderr as due (never
 * the address). */
function cliMailer(env: ReturnType<typeof loadAdminEnv>): Mailer {
  if (!env.smtpUrl || !env.publicUrl) {
    if (env.smtpUrl) stderrLog.warn({}, 'KEPT_PUBLIC_URL is needed to send mail; logging instead');
    return logMailer(stderrLog);
  }
  const localeOf = async (email: string) => {
    const client = new pg.Client({
      connectionString: env.ownerUrl,
      application_name: 'kept-admin',
    });
    // A backend ended under it emits 'error'; unhandled, that ends the process instead of
    // failing the lookup.
    client.on('error', () => {});
    await client.connect();
    try {
      return await profileLocaleLookup(client)(email);
    } finally {
      await client.end();
    }
  };
  const setup = createMailer(
    { KEPT_SMTP_URL: env.smtpUrl, KEPT_SMTP_FROM: env.smtpFrom, KEPT_PUBLIC_URL: env.publicUrl },
    { localeOf, logger: stderrLog },
  );
  return {
    send: async (mail) => {
      try {
        await setup.mailer.send(mail);
      } catch (err) {
        stderrLog.warn({ mail: mail.kind, err: String(err) }, 'mail failed');
        throw err;
      }
    },
  };
}

export function buildCli(): Command {
  const program = new Command();
  program.name('kept').description('Kept operator CLI');

  program
    .command('migrate')
    .description('Run pending database migrations under an advisory lock')
    .option(
      '--skip-snapshot',
      'migrate without the pre-upgrade snapshot (as KEPT_UPGRADE_SNAPSHOT=off)',
    )
    .option(
      '--allow-downgrade',
      'migrate a database more than one release ahead of this image (as KEPT_ALLOW_DOWNGRADE=1; audited)',
    )
    .action(async (opts: { skipSnapshot?: boolean; allowDowngrade?: boolean }) => {
      // The owner login; the keys only when given (the pre-upgrade snapshot opens the saved
      // backup credentials with them, step-8 T8, Q8).
      const { ownerUrl } = loadMigrateEnv();
      const raw = process.env;
      const skip = opts.skipSnapshot === true || raw.KEPT_UPGRADE_SNAPSHOT === 'off';
      const outcome = await runMigrations(ownerUrl, {
        release: { version: KEPT_VERSION, revision: raw.KEPT_REVISION ?? null },
        allowDowngrade: opts.allowDowngrade === true || raw.KEPT_ALLOW_DOWNGRADE === '1',
        snapshot: skip ? null : await migratePreUpgradeSnapshot(raw),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      if (outcome.snapshot === 'taken') console.log('Pre-upgrade snapshot taken.');
    });

  // Instance administration from the server itself (D165, D190), as kept_owner: the way back in
  // when there is no SMTP or the only admin is locked out. Each command is audited as `system`,
  // and a person whose account it touches is mailed (D180).
  const admin = program.command('admin').description('Instance administration commands');

  admin
    .command('reset-password')
    .argument('<login>', "the email address, or a managed account's username")
    .description('Issue a one-time password reset code (valid 1 hour) and sign the account out')
    .action(async (login: string) => {
      const env = loadAdminEnv();
      const issued = await resetPassword(env.ownerUrl, cliMailer(env), login, env.publicUrl);
      console.log(
        `One-time password reset for ${issued.login}, valid until ${issued.expiresAt.toISOString()}.`,
      );
      console.log('Every session of the account was signed out.');
      console.log(`KEPT RESET CODE: ${issued.code}`);
      console.log(
        issued.url
          ? `Open ${issued.url} to choose a new password.`
          : `Open /auth/reset#token=${issued.code} on this Kept's address to choose a new password.`,
      );
    });

  admin
    .command('setup-code')
    .description('Re-issue the first-run setup code (only while setup is pending)')
    .action(async () => {
      const env = loadAdminEnv();
      console.log(setupCodeLine(await reissueSetupCode(env.ownerUrl, cliMailer(env))));
    });

  admin
    .command('disable-user')
    .argument('<login>', "the email address, or a managed account's username")
    .description('Disable an account: it can no longer sign in, and every session ends')
    .action(async (login: string) => {
      const env = loadAdminEnv();
      const user = await disableUserByLogin(env.ownerUrl, cliMailer(env), login);
      console.log(`Disabled ${user.id}; every session was signed out.`);
    });

  admin
    .command('enable-user')
    .argument('<login>', "the email address, or a managed account's username")
    .description('Let a disabled account sign in again')
    .action(async (login: string) => {
      const env = loadAdminEnv();
      const user = await enableUserByLogin(env.ownerUrl, cliMailer(env), login);
      console.log(`Enabled ${user.id}.`);
    });

  admin
    .command('transfer-ownership')
    .argument('<locationId>', 'the location to move')
    .argument('<toUserId>', 'the user who becomes its owner')
    .description('Move a location to another owner (the previous owner, if any, becomes an admin)')
    .action(async (locationId: string, toUserId: string) => {
      const env = loadAdminEnv();
      const moved = await transferOwnership(env.ownerUrl, cliMailer(env), locationId, toUserId);
      console.log(`"${moved.name}" (${moved.locationId}) now belongs to ${moved.to}.`);
    });

  admin
    .command('seed')
    .description(
      'Development data through the service layer: households with their inventory, or the 10k bench (never in production)',
    )
    .option('--scenario <name>', `one of: ${SCENARIOS.join(', ')}`, 'households')
    .option('--things <n>', 'bench: things in the largest location', '10000')
    .action(async (opts: { scenario: string; things: string }) => {
      assertSeedAllowed(process.env.NODE_ENV);
      if (!(SCENARIOS as readonly string[]).includes(opts.scenario)) {
        throw new SeedError(`unknown scenario ${opts.scenario}; one of: ${SCENARIOS.join(', ')}`);
      }
      // The runtime logins, as the server has them: the seed goes through the same routes.
      const env = await loadEnv(process.env, { logger: (line) => console.error(line) });
      const pools = createPools(env);
      try {
        const report = await runSeed(opts.scenario as Scenario, env, pools, {
          files: await createFileStorage(env),
          // The secret values (the router's Wi-Fi password) need the keyring, as main.ts has it.
          app: { secretKeys: secretKeysOf(env) },
          bench: {
            things: Number(opts.things),
            onProgress: (line) => console.error(line),
            // ANALYZE after the bulk needs the tables' owner; optional.
            ownerUrl: process.env.KEPT_OWNER_DATABASE_URL || undefined,
          },
        });
        process.stdout.write(formatSeedReport(report, env.KEPT_PUBLIC_URL));
      } finally {
        await closePools(pools);
      }
    });

  admin
    .command('recovery-kit')
    .description(
      'Print the recovery kit to keep off the server: the keys, the backup repository and its credentials, the restore steps (D165, D182)',
    )
    .option('--format <format>', 'text, or html for a printable page', 'text')
    .option('--out <file>', 'write it to this file, readable by you only, instead of printing it')
    .action(async (opts: { format: string; out?: string }) => {
      process.exitCode = await recoveryKitCommand(process.env, opts, {
        write: (text) => process.stdout.write(text),
        warn: (line) => console.error(line),
      });
    });

  admin
    .command('rotate-key')
    .description(
      'Make a new KEPT_SECRET_KEY current and re-wrap every stored secret under it (§7.3)',
    )
    .option('--new-key <key>', 'the new key (kept admin gen-key); generated when omitted')
    .option('--resume', 're-wrap what is not under the current key yet; no new key')
    .option(
      '--drop <version>',
      'remove a retired key version no stored value uses (old backups need it; keep a kit)',
    )
    .action(async (opts: { newKey?: string; resume?: boolean; drop?: string }) => {
      if (opts.drop !== undefined && !/^[1-9]\d{0,8}$/.test(opts.drop)) {
        throw new CliError('--drop takes a key version: a whole number from 1');
      }
      process.exitCode = await rotateKey(
        process.env,
        {
          ...(opts.newKey ? { newKey: opts.newKey } : {}),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.drop !== undefined ? { drop: Number(opts.drop) } : {}),
        },
        (line) => console.log(line),
      );
    });

  // Step 8 (T5, T7; D64, D66): restic snapshots on demand, the list, verify, the restore drill
  // and a stale lock's removal; the raw export; the restore.
  const backup = admin
    .command('backup')
    .description('Back up the database and the files now (a restic snapshot), or list snapshots')
    .option('--list', 'list the snapshots, newest first, and any older pre-restic backups')
    .option('--accept-size', 'accept a much smaller backup as the new normal (L79)')
    .action(async (opts: { list?: boolean; acceptSize?: boolean }) => {
      process.exitCode = await backupCommand(
        process.env,
        { ...(opts.list ? { list: true } : {}), ...(opts.acceptSize ? { acceptSize: true } : {}) },
        (line) => console.log(line),
      );
    });
  backup
    .command('verify')
    .description('Check the backup repository; with S3 file storage, the files against the bucket')
    .option('--read-data <percent>', 'also read this share of the backed-up data, e.g. 5%')
    .option('--all-files', 'read every file in the bucket, not one in 20')
    .action(async (opts: { readData?: string; allFiles?: boolean }) => {
      process.exitCode = await backupVerifyCommand(process.env, opts, (line) => console.log(line));
    });
  backup
    .command('drill')
    .description('Restore the newest backup into an EMPTY scratch database and check it (monthly)')
    .requiredOption('--into <url>', 'the scratch database, a postgres:// URL for kept_owner')
    .option('--all-files', 'check every file, not a sample of 50')
    .action(async (opts: { into: string; allFiles?: boolean }) => {
      process.exitCode = await backupDrillCommand(process.env, opts, (line) => console.log(line));
    });
  backup
    .command('unlock')
    .description('Remove a stale restic lock after a crash (refused while a backup runs)')
    .action(async () => {
      process.exitCode = await backupUnlockCommand(process.env, {}, (line) => console.log(line));
    });

  // Step 8 (T6, D159): the readable copy every snapshot holds, on demand.
  admin
    .command('readable')
    .description("Write every location's readable copy (HTML, CSV, files) into a directory")
    .requiredOption('--out <dir>', 'the directory to write into')
    .option('--location <id>', 'one location only')
    .option('--no-pdf', 'leave out the inventory PDFs')
    .action(async (opts: { out: string; location?: string; pdf?: boolean }) => {
      process.exitCode = await readableCommand(process.env, opts, (line) => console.log(line));
    });

  admin
    .command('export')
    .description('Write every row (raw JSON, secrets sealed) and every file to a new directory')
    .requiredOption('--out <dir>', 'a new or empty directory')
    .action(async (opts: { out: string }) => {
      process.exitCode = await exportCommand(process.env, opts.out, (line) => console.log(line));
    });

  admin
    .command('restore')
    .argument('<snapshot>', 'a snapshot id (kept admin backup --list) or `latest`')
    .option('--legacy', 'the argument is a pre-restic backup id or run directory (one release)')
    .description(
      'Restore a backup into the EMPTY database KEPT_OWNER_DATABASE_URL names, then verify it',
    )
    .action(async (snapshot: string, opts: { legacy?: boolean }) => {
      process.exitCode = await restoreCommand(
        process.env,
        snapshot,
        opts.legacy ? { legacy: true } : {},
        (line) => console.log(line),
      );
    });

  // Step 8 (T13, D186): switching file storage between local and S3, verified.
  const storage = admin
    .command('storage')
    .description('Move file storage between local and S3 (copy, then verify)');
  storage
    .command('copy')
    .description(
      'Copy every file the database references from the store KEPT_STORAGE names to the other one, each checked by its SHA-256; run it again to pick up what arrived since',
    )
    .requiredOption('--to <store>', '`s3` or `local`')
    .option('--dry-run', 'count what would be copied; copy nothing')
    .action(async (opts: { to: string; dryRun?: boolean }) => {
      process.exitCode = await storageCopyCommand(
        process.env,
        { to: opts.to, ...(opts.dryRun ? { dryRun: true } : {}) },
        (line) => console.log(line),
      );
    });
  storage
    .command('verify')
    .description('Check every file the database references is in a store with the right bytes')
    .requiredOption('--store <store>', '`s3` or `local`')
    .action(async (opts: { store: string }) => {
      process.exitCode = await storageVerifyCommand(process.env, opts, (line) => console.log(line));
    });

  // T21's follow-up: PDFs uploaded before the upload queued their text get it now.
  admin
    .command('backfill-pdf-text')
    .description(
      'Queue the text of every PDF that has none yet (uploaded before PDF text), for document search',
    )
    .option('--batch <n>', 'PDFs read and queued per batch (1 to 1000)', '200')
    .option('--dry-run', 'count them; queue nothing')
    .action(async (opts: { batch: string; dryRun?: boolean }) => {
      process.exitCode = await backfillPdfTextCommand(
        process.env,
        { batch: opts.batch, ...(opts.dryRun ? { dryRun: true } : {}) },
        (line) => console.log(line),
      );
    });

  admin
    .command('gen-key')
    .description('Print a new 32-byte key as base64url, for KEPT_SECRET_KEY (§7.3)')
    .action(() => {
      console.log(generateKey());
    });

  admin
    .command('config')
    .description('Print the environment variable reference (D81)')
    .action(() => {
      console.log(renderEnvReference());
    });

  return program;
}

/** True when `moduleUrl` is the file node was started with. Installed bins are symlinks
 * (node_modules/.bin/kept -> dist/cli/index.js), and node reports the resolved path in
 * import.meta.url but the link in argv[1], so both sides are compared as real paths. */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

// Only auto-run when this file is the process entrypoint, not when a test imports it.
if (isEntrypoint(import.meta.url)) {
  buildCli()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(
        err instanceof EnvError ||
          err instanceof CliError ||
          err instanceof BackupError ||
          err instanceof RestoreError ||
          err instanceof ExportError ||
          err instanceof PgToolError ||
          err instanceof SeedError ||
          err instanceof SeedRefused
          ? `kept: ${err.message}`
          : err,
      );
      process.exitCode = 1;
    });
}
