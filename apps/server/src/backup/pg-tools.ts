import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';

// pg_dump and pg_restore (T31c). They must be the database server's major version: an older
// pg_dump refuses a newer server, and a dump from a newer one may not restore. The image installs
// PGDG's postgresql-client-18 (Dockerfile); every run checks the version before it dumps.
//
// The password never reaches a command line (where `ps` shows it): the URL is passed without it,
// and PGPASSWORD carries it in the child's environment. The dump is written to stdout and read
// from stdin, so a runner that wraps the tools (tests run them inside the dev database's
// container, which has the matching version) needs no shared filesystem.

export type PgToolsOptions = {
  /** Put before `pg_dump`/`pg_restore`, e.g. `docker compose -f … exec -T -e PGPASSWORD db`. */
  prefix?: readonly string[];
  /** The URL as the tools must reach the server (tests: the container's own port). */
  mapUrl?: (url: string) => string;
};

export type PgTools = {
  /** The major version of pg_dump and of pg_restore. */
  versions(): Promise<{ dump: number; restore: number }>;
  /** Custom-format dump of the whole database to `outFile`. */
  dump(url: string, outFile: string, opts?: { snapshot?: string }): Promise<void>;
  /** Restores `inFile` into the (empty) database at `url`, in one transaction. */
  restore(url: string, inFile: string): Promise<void>;
};

export class PgToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgToolError';
  }
}

/** A URL's password moved out, so it can go in PGPASSWORD. */
export function splitPassword(url: string): { url: string; password: string | undefined } {
  const parsed = new URL(url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.password = '';
  return { url: parsed.toString(), password };
}

/** Error text with anything that looks like a URL's credentials removed. */
export function redact(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi, '$1:***@');
}

type Run = { args: string[]; url: string; stdin?: string; stdout?: string };

export function pgTools(opts: PgToolsOptions = {}): PgTools {
  const prefix = opts.prefix ?? [];
  const mapUrl = opts.mapUrl ?? ((url: string) => url);

  async function run(tool: 'pg_dump' | 'pg_restore', r: Run): Promise<string> {
    const { url, password } = splitPassword(mapUrl(r.url));
    const argv = [...prefix, tool, ...r.args, `--dbname=${url}`];
    const [cmd, ...rest] = argv as [string, ...string[]];
    const child = spawn(cmd, rest, {
      env: { ...process.env, ...(password !== undefined ? { PGPASSWORD: password } : {}) },
      stdio: [r.stdin ? 'pipe' : 'ignore', r.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const piping: Promise<unknown>[] = [];
    if (r.stdin && child.stdin) {
      const input = createReadStream(r.stdin);
      input.pipe(child.stdin);
      piping.push(once(input, 'end').catch(() => {}));
      child.stdin.on('error', () => {});
    }
    if (r.stdout && child.stdout) {
      const output = createWriteStream(r.stdout, { mode: 0o600 });
      child.stdout.pipe(output);
      piping.push(once(output, 'close'));
    }
    const failed = once(child, 'error').then(([err]) => {
      throw new PgToolError(`${tool} could not start: ${(err as Error).message}`);
    });
    const [code] = (await Promise.race([once(child, 'close'), failed])) as [number | null];
    await Promise.all(piping);
    if (code !== 0) {
      throw new PgToolError(
        `${tool} failed (exit ${code}): ${redact(stderr.trim()).slice(0, 600)}`,
      );
    }
    return stderr;
  }

  async function major(tool: 'pg_dump' | 'pg_restore'): Promise<number> {
    const [cmd, ...rest] = [...prefix, tool, '--version'] as unknown as [string, ...string[]];
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    const failed = once(child, 'error').then(([err]) => {
      throw new PgToolError(
        `${tool} is not installed or not on the PATH (${(err as Error).message}); Kept's image ships it`,
      );
    });
    const [code] = (await Promise.race([once(child, 'close'), failed])) as [number | null];
    const match = /\(PostgreSQL\)\s+(\d+)/.exec(out);
    if (code !== 0 || !match) throw new PgToolError(`could not read ${tool}'s version`);
    return Number(match[1]);
  }

  return {
    versions: async () => ({ dump: await major('pg_dump'), restore: await major('pg_restore') }),
    dump: async (url, outFile, dumpOpts = {}) => {
      await run('pg_dump', {
        url,
        stdout: outFile,
        args: [
          '--format=custom',
          // Kept's tables force row-level security on their owner too; kept_owner reads every
          // row through its owner_all policies, and pg_dump would otherwise refuse (it turns
          // row security off, which only a BYPASSRLS role may).
          '--enable-row-security',
          // pg_trgm, unaccent and vector belong to the superuser that created them (initdb, or
          // the managed provider); the restore target has them already and kept_owner may not
          // comment on them. The manifest lists them, and restore checks they exist.
          '--exclude-extension=*',
          ...(dumpOpts.snapshot ? [`--snapshot=${dumpOpts.snapshot}`] : []),
        ],
      });
    },
    restore: async (url, inFile) => {
      await run('pg_restore', {
        url,
        stdin: inFile,
        args: ['--exit-on-error', '--single-transaction', '--no-owner'],
      });
    },
  };
}
