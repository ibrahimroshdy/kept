import { randomInt } from 'node:crypto';
import {
  compareSemver,
  parseSemver,
  UPDATE_CHECK_ERRORS,
  type UpdateCheckError,
  type UpdateCheckState,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { guardedFetch } from '../net/ssrf.js';

// The opt-in update check (D65; step-8 plan T11, Q16; docs/spikes/2026-10-06-step8-updates.md).
//
// Off by default. When an instance admin turns it on (or KEPT_UPDATE_CHECK=true locks it on), the
// daily `update-check` job, or "Check now", asks GitHub one question: what is the latest release
// of the repository KEPT_SOURCE_URL names (the image's OCI source label, so a fork asks about its
// own releases). Nothing else is sent: a `User-Agent` of `Kept` (GitHub refuses a request without
// one), the media type and the API version, and never Kept's version, the instance's address or
// any identifier (D65: "nothing sent but the request"). Nothing is downloaded or installed; the
// answer is stored for the status page.
//
// The request goes through guardedFetch with private addresses refused, whatever the admin's
// `ssrf_allow_private` says, and redirects refused (a renamed repository's 301 is `unreachable`,
// never followed: a redirect must not choose the host). A timeout and a body cap are ours, since
// guardedFetch has neither.

/** `instance_settings` keys: the admin's switch, and the last answer. */
export const UPDATE_CHECK_ENABLED_KEY = 'update_check_enabled';
export const UPDATE_CHECK_STATE_KEY = 'update_check';

export const GITHUB_API = 'https://api.github.com';
/** The API version the spike pinned (2022-11-28 ends in March 2028; this one has no end yet). */
export const GITHUB_API_VERSION = '2026-03-10';
/** The only headers sent. */
export const UPDATE_CHECK_HEADERS = Object.freeze({
  'User-Agent': 'Kept',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
});
const TIMEOUT_MS = 10_000;
/** restic's latest release was 48,615 bytes, mostly notes; ten releases stay well under this. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Releases read when the running version is a prerelease (the list endpoint, newest first). */
const PRERELEASE_PAGE = 10;

const OWNER = /^[A-Za-z0-9-]+$/;
const REPO = /^[A-Za-z0-9._-]+$/;

/**
 * The GitHub repository a source URL names, or null when it isn't one (spike U1's rule): `https:`
 * on exactly `github.com`; the first two path segments, a trailing `.git` and anything from an
 * `@` (`…/kept@abc123`) dropped, the rest of the path (`/tree/<rev>`) ignored; owner and repo
 * each from a strict character set, so nothing but those two values reaches the request URL.
 */
export function githubRepoOf(
  sourceUrl: string | null | undefined,
): { owner: string; repo: string } | null {
  if (!sourceUrl) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') return null;
  if (url.username || url.password) return null;
  const [owner, rawRepo] = url.pathname.split('/').filter((s) => s !== '');
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.split('@')[0]?.replace(/\.git$/, '') ?? '';
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** The fields Kept reads from a release (all required in GitHub's schema; `published_at` may be
 * null). Everything else in the body is ignored. */
const Release = z.object({
  tag_name: z.string().max(256),
  html_url: z.url({ protocol: /^https$/ }).max(2048),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
});
type Release = z.infer<typeof Release>;

export type UpdateCheckResult = {
  latest: UpdateCheckState['latest'];
  error: UpdateCheckError | null;
};

export type CheckOptions = {
  sourceUrl: string | null | undefined;
  /** The running version (KEPT_VERSION). */
  version: string;
  /** Default: guardedFetch, private addresses refused. Tests pass one allowed to reach their
   * local stub. */
  fetch?: typeof fetch;
  /** Default GITHUB_API. Only tests change it (a local stub); no setting or variable does. */
  apiBase?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
};

class BodyTooLarge extends Error {}

/** The body as text, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A release as the state stores it, when it is newer than `running`; null otherwise. */
function newerThan(running: string, release: Release): UpdateCheckState['latest'] | 'bad' {
  const version = parseSemver(release.tag_name);
  if (!version || !release.published_at) return 'bad';
  if (compareSemver(version, running) <= 0) return null;
  const { major, minor, patch, prerelease } = version;
  const text = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`;
  return { version: text, url: release.html_url, publishedAt: release.published_at };
}

/**
 * Asks GitHub once. `/releases/latest` never returns a draft or a prerelease; a running
 * prerelease reads the newest ten releases instead and takes the highest version that isn't a
 * draft (plan T11: "prereleases only when the running version is one"). Never throws.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateCheckResult> {
  const repo = githubRepoOf(opts.sourceUrl);
  if (!repo) return { latest: null, error: 'not_github' };
  const running = parseSemver(opts.version);
  if (!running) return { latest: null, error: 'bad_response' };
  const pre = running.prerelease.length > 0;
  const base = `${opts.apiBase ?? GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases`;
  const url = pre ? `${base}?per_page=${PRERELEASE_PAGE}` : `${base}/latest`;
  const doFetch = opts.fetch ?? guardedFetch({ allowPrivate: false });

  let res: Response;
  let body: string;
  try {
    // A string URL and plain headers: guardedFetch keeps only the URL of a Request object.
    res = await doFetch(url, {
      method: 'GET',
      headers: { ...UPDATE_CHECK_HEADERS },
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { latest: null, error: 'not_found' };
    }
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get('x-ratelimit-remaining') === '0'
    ) {
      await res.body?.cancel().catch(() => {});
      return { latest: null, error: 'rate_limited' };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { latest: null, error: 'unreachable' };
    }
    body = await readCapped(res, opts.maxBodyBytes ?? MAX_BODY_BYTES);
  } catch (err) {
    return { latest: null, error: err instanceof BodyTooLarge ? 'bad_response' : 'unreachable' };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { latest: null, error: 'bad_response' };
  }
  if (!pre) {
    const release = Release.safeParse(json);
    if (!release.success || release.data.draft) return { latest: null, error: 'bad_response' };
    const latest = newerThan(opts.version, release.data);
    return latest === 'bad' ? { latest: null, error: 'bad_response' } : { latest, error: null };
  }
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) return { latest: null, error: 'bad_response' };
  let best: NonNullable<UpdateCheckState['latest']> | null = null;
  for (const item of list.data) {
    const release = Release.safeParse(item);
    if (!release.success || release.data.draft) continue;
    const candidate = newerThan(opts.version, release.data);
    if (!candidate || candidate === 'bad') continue;
    if (!best || compareSemver(candidate.version, best.version) > 0) best = candidate;
  }
  return { latest: best, error: null };
}

// --- What is stored ----------------------------------------------------------------------------

/** `instance_settings.update_check`: the last answer, and the hour of the day (UTC) the daily
 * job asks in, picked at random once so instances don't all ask GitHub together. */
const StoredState = z.object({
  lastCheckedAt: z.string().nullable().catch(null),
  latest: z
    .object({ version: z.string(), url: z.string(), publishedAt: z.string() })
    .nullable()
    .catch(null),
  error: z.enum(UPDATE_CHECK_ERRORS).nullable().catch(null),
  hour: z.number().int().min(0).max(23).optional().catch(undefined),
});
type StoredState = z.infer<typeof StoredState>;

const EMPTY: StoredState = { lastCheckedAt: null, latest: null, error: null };

/** KEPT_UPDATE_CHECK, parsed: true/false locks the switch; undefined leaves it to the admin. */
export type UpdateCheckEnv = { KEPT_UPDATE_CHECK?: boolean | undefined };

async function readKeys(client: pg.ClientBase) {
  const { rows } = await client.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM public.instance_settings WHERE key = ANY($1::text[])',
    [[UPDATE_CHECK_ENABLED_KEY, UPDATE_CHECK_STATE_KEY]],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const parsed = StoredState.safeParse(map.get(UPDATE_CHECK_STATE_KEY) ?? EMPTY);
  return {
    storedEnabled: map.get(UPDATE_CHECK_ENABLED_KEY) === true,
    stored: parsed.success ? parsed.data : EMPTY,
  };
}

/** The switch as Admin → Settings shows it: the environment's value, locked, else the admin's
 * (off until turned on). */
export function updateCheckSwitch(env: UpdateCheckEnv, storedEnabled: boolean) {
  const locked = env.KEPT_UPDATE_CHECK !== undefined;
  return { value: locked ? env.KEPT_UPDATE_CHECK === true : storedEnabled, locked };
}

/** The status page's `updates` (AdminOpsStatus, plan T10), from rows already kept. */
export async function readUpdateCheck(
  client: pg.ClientBase,
  env: UpdateCheckEnv,
): Promise<UpdateCheckState> {
  const { storedEnabled, stored } = await readKeys(client);
  const { value, locked } = updateCheckSwitch(env, storedEnabled);
  return {
    enabled: value,
    locked,
    lastCheckedAt: stored.lastCheckedAt,
    latest: stored.latest,
    error: stored.error,
  };
}

/** Whether the switch is on (the job's and "Check now"'s gate). */
export async function updateCheckEnabled(
  client: pg.ClientBase,
  env: UpdateCheckEnv,
): Promise<boolean> {
  const { storedEnabled } = await readKeys(client);
  return updateCheckSwitch(env, storedEnabled).value;
}

async function writeState(client: pg.ClientBase, state: StoredState) {
  await client.query(
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [UPDATE_CHECK_STATE_KEY, JSON.stringify(state)],
  );
}

/** Stores one answer, keeping the job's hour. */
export async function storeUpdateCheck(
  client: pg.ClientBase,
  result: UpdateCheckResult,
  at: Date,
): Promise<void> {
  const { stored } = await readKeys(client);
  await writeState(client, {
    lastCheckedAt: at.toISOString(),
    latest: result.latest,
    error: result.error,
    ...(stored.hour !== undefined ? { hour: stored.hour } : {}),
  });
}

const HOUR_MS = 3_600_000;

/**
 * Whether the hourly job should ask now: never asked; or a day has passed and this is the
 * instance's hour; or two days have passed (the server was down at its hour). So it asks about
 * once a day, and a `rate_limited` answer waits for the next day (spike U1).
 */
export function updateCheckDue(state: StoredState, hour: number, now: Date): boolean {
  if (!state.lastCheckedAt) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  const elapsed = now.getTime() - last;
  if (elapsed >= 47 * HOUR_MS) return true;
  return elapsed >= 23 * HOUR_MS && now.getUTCHours() === hour;
}

/** Runs `fn` in its own transaction (withSystem on kept_system, for the job). */
export type InTx = <T>(fn: (client: pg.ClientBase) => Promise<T>) => Promise<T>;

/**
 * The hourly `update-check` job's work (updates/job.ts): nothing at all while the switch is off;
 * otherwise one check when it is due, stored. Picks and stores the instance's hour the first
 * time. The request runs between two short transactions, never inside one. Returns whether it
 * asked.
 */
export async function runScheduledUpdateCheck(
  inTx: InTx,
  opts: CheckOptions & { env: UpdateCheckEnv; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const due = await inTx(async (client) => {
    const { storedEnabled, stored } = await readKeys(client);
    if (!updateCheckSwitch(opts.env, storedEnabled).value) return false;
    let hour = stored.hour;
    if (hour === undefined) {
      hour = randomInt(24);
      await writeState(client, { ...stored, hour });
    }
    return updateCheckDue(stored, hour, now);
  });
  if (!due) return false;
  const result = await checkForUpdate(opts);
  await inTx((client) => storeUpdateCheck(client, result, now));
  return true;
}
