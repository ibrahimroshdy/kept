import { z } from 'zod';

// restic's `--json` messages (step-8 plan T5), one zod schema per message type, as the R1 spike
// recorded them from restic 0.19.1 (docs/spikes/2026-10-06-step8-restic.md, "JSON messages") and
// restic's scripting docs. What R1 found and these follow:
// - zero-valued numbers are omitted (the first `status` line had no `seconds_elapsed`), so every
//   count is optional with a default of 0;
// - `snapshots`, `forget` and `stats` print one JSON document; `backup`, `restore`, `ls`, `check`
//   and `init` print one object per line;
// - a fatal error is one `exit_error` line on stderr, which plain-text warnings can precede, so
//   stderr is read line by line and lines that aren't JSON are kept as log text only;
// - `prune` prints text, not JSON: Kept runs `forget --prune`, whose stdout stays one document.
// An unknown message type is ignored; a known one that doesn't parse fails the command.

const count = z.number().nonnegative().optional().default(0);

/** stderr: `{"message_type":"exit_error","code":<n>,"message":"<text>"}`. */
export const ExitError = z.object({
  message_type: z.literal('exit_error'),
  code: z.number().int(),
  message: z.string(),
});

/** `init`. */
export const Initialized = z.object({
  message_type: z.literal('initialized'),
  id: z.string(),
  repository: z.string(),
});

/** `backup`: a file it could not read (exit 3 follows). */
export const BackupError = z.object({
  message_type: z.literal('error'),
  error: z.object({ message: z.string() }).loose(),
  during: z.string().optional(),
  item: z.string().optional(),
});

/** `backup`'s last line. */
export const BackupSummary = z.object({
  message_type: z.literal('summary'),
  files_new: count,
  files_changed: count,
  files_unmodified: count,
  dirs_new: count,
  dirs_changed: count,
  dirs_unmodified: count,
  data_blobs: count,
  tree_blobs: count,
  data_added: count,
  data_added_packed: count,
  total_files_processed: count,
  total_bytes_processed: count,
  total_duration: count,
  snapshot_id: z.string().regex(/^[0-9a-f]{64}$/),
  dry_run: z.boolean().optional(),
});

/** One snapshot, in `snapshots`' array, `ls`'s first line and `forget`'s groups. `parent`,
 * `tags`, `username`, `uid`/`gid` are omitted when empty. */
export const Snapshot = z
  .object({
    time: z.string(),
    paths: z.array(z.string()).nullable().optional(),
    hostname: z.string(),
    tags: z.array(z.string()).nullable().optional(),
    id: z.string().regex(/^[0-9a-f]{64}$/),
    short_id: z.string().optional(),
  })
  .loose();

export const Snapshots = z.array(Snapshot);

/** `ls`: one per entry, after the snapshot line. */
export const LsNode = z.object({
  message_type: z.literal('node'),
  name: z.string(),
  type: z.string(),
  path: z.string(),
  size: count,
});

/** `stats --mode raw-data` (and the default mode's first three fields). */
export const Stats = z
  .object({
    total_size: count,
    total_file_count: count,
    snapshots_count: count,
  })
  .loose();

/** `check`'s last line, and its error lines. */
export const CheckSummary = z.object({
  message_type: z.literal('summary'),
  num_errors: count,
  broken_packs: z.array(z.string()).nullable().optional(),
  suggest_repair_index: z.boolean().optional(),
  suggest_prune: z.boolean().optional(),
});
export const CheckError = z.object({ message_type: z.literal('error'), message: z.string() });

/** `restore`'s last line. `files_restored` counts directories too (R1: 4 for 3 files). */
export const RestoreSummary = z.object({
  message_type: z.literal('summary'),
  total_files: count,
  files_restored: count,
  total_bytes: count,
  bytes_restored: count,
});

/** `forget`: an array of groups. */
export const ForgetGroups = z.array(
  z
    .object({
      keep: z.array(Snapshot).nullable().optional(),
      remove: z.array(Snapshot).nullable().optional(),
    })
    .loose(),
);

/** `cat config`: the repository exists (and the password opens it). */
export const RepoConfig = z.object({ version: z.number().int(), id: z.string() }).loose();

export class ResticJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResticJsonError';
  }
}

/** The JSON objects in a line-per-message output, by `message_type`. Lines that aren't JSON
 * objects are returned as `text` (log only). */
export function splitLines(output: string): {
  messages: Record<string, unknown>[];
  text: string[];
} {
  const messages: Record<string, unknown>[] = [];
  const text: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('{')) {
      text.push(line);
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        messages.push(value as Record<string, unknown>);
      } else {
        text.push(line);
      }
    } catch {
      text.push(line);
    }
  }
  return { messages, text };
}

/** The messages of one type, each parsed with its schema; a malformed one throws. */
export function messagesOf<T extends z.ZodType>(
  messages: readonly Record<string, unknown>[],
  type: string,
  schema: T,
): z.infer<T>[] {
  const out: z.infer<T>[] = [];
  for (const m of messages) {
    if (m.message_type !== type) continue;
    const parsed = schema.safeParse(m);
    if (!parsed.success) throw new ResticJsonError(`restic printed a malformed ${type} message`);
    out.push(parsed.data);
  }
  return out;
}

/** One JSON document (`snapshots`, `forget`, `stats`, `cat config`), parsed with its schema. */
export function documentOf<T extends z.ZodType>(
  output: string,
  schema: T,
  what: string,
): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new ResticJsonError(`restic ${what} printed something that isn't JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResticJsonError(`restic ${what} printed a malformed document`);
  return parsed.data;
}

/** The `exit_error` message on stderr, if restic printed one. */
export function exitErrorOf(stderr: string): z.infer<typeof ExitError> | null {
  const { messages } = splitLines(stderr);
  for (const m of messages.reverse()) {
    if (m.message_type !== 'exit_error') continue;
    const parsed = ExitError.safeParse(m);
    if (parsed.success) return parsed.data;
  }
  return null;
}
