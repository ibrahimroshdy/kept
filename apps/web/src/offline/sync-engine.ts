/**
 * The sync engine (plan T24; engineering spec §2.2, §2.3, §7.4; D17, D35, D36, D101, D112, D148,
 * D156, D181). It moves the queue to the server and the server's snapshot to the phone.
 *
 * **When it runs:** on start (app open), when the page becomes visible, when the network comes
 * back, after each enqueue, and every 60 s while visible. Never in the background: Safari has no
 * Background Sync, so on iOS the queue uploads only while Kept is open (D36, D101). While hidden
 * with work left, the app icon carries the count (Badging API, where the installed app has it),
 * and the status line says "Open to finish syncing (N)".
 *
 * **One run at a time, across tabs:** `navigator.locks` ('kept-sync', iOS 15.4+); where it is
 * missing, a BroadcastChannel claim (a tab that is syncing answers "busy"). Two runs at once would
 * still be safe (every op and file is replay-safe by its key), only wasteful.
 *
 * **One run, in order:**
 * 1. queued payloads written by an older build are upgraded to this one's version (D148);
 * 2. **uploads:** each entry's files, in queue order (uploader.ts);
 * 3. **ops:** `POST /sync/ops`, 50 at a time, strictly in queue order, stopping at the first entry
 *    whose files aren't up yet (queue.ts). Each answer settles its entry: `applied` swaps "ID
 *    pending" for the code (D112); `needs_review` and `dropped` leave a notice (D35: "the drill
 *    was trashed by Alfred", with the inbox item to restore it). A 409 `client_outdated` or
 *    `server_outdated` blocks the batch and **keeps the queue** (D148);
 * 4. **snapshot:** pages until complete (snapshot.ts); applied entries older than the pass leave.
 *    A cursor the server refuses (400: its auth secret changed) drops the cached copy, never the
 *    queue, and a full pass follows at once.
 *
 * **Engine status** (what sync-status.tsx shows): `phase` is idle → uploading → sending → pulling
 * → idle; `problem` says why the last run stopped short: offline, server (retried with back-off,
 * 5 s doubling to 5 min), client_outdated / server_outdated (blocked until an app start, a new
 * build, or the 30-minute retry), storage_full. A 401 anywhere clears the cached inventory and
 * signs out, keeping the person's own unsent queue locked for their next sign-in (D181, D210);
 * the engine stops.
 */
import {
  KEPT_VERSION,
  type QueueItem,
  type SyncOpResult,
  type SyncOpsRequest,
  type SyncOpsResponse,
  type UpgraderTable,
} from '@kept/shared';
import { captureApi } from '@/api/capture/queries';
import { ApiError } from '@/api/client';
import { requestPersistence, StorageFullError } from './persist';
import { nextBatch, upgradeEntry } from './queue';
import { type PullResult, pullSnapshot, type SnapshotFetch } from './snapshot';
import type { LocalBlob, QueueEntry, SyncNotice } from './store';
import type { SyncStore } from './sync-store';
import { type UploadHttp, uploadEntryFiles, uploadHttp } from './uploader';

export type SyncHttp = UploadHttp & {
  snapshot: SnapshotFetch;
  syncOps: (body: SyncOpsRequest) => Promise<SyncOpsResponse>;
};

export const defaultHttp: SyncHttp = {
  ...uploadHttp,
  snapshot: (params) => captureApi.snapshot(params),
  syncOps: (body) => captureApi.syncOps(body),
};

export type SyncPhase = 'idle' | 'uploading' | 'sending' | 'pulling';
export type SyncProblem =
  | 'offline'
  | 'server'
  | 'client_outdated'
  | 'server_outdated'
  | 'storage_full';

export type SyncStatus = {
  phase: SyncPhase;
  problem: SyncProblem | null;
  /** When a run last finished cleanly (ms), for "as of last sync". */
  lastSyncAt: number | null;
  /** The snapshot's own time: "as of last sync, 14:02" (D188). */
  asOf: string | null;
  counts: { waiting: number; uploading: number; needsAttention: number };
  /** Only part of the Kept fits on this phone (Q30). */
  truncated: boolean;
  /** `navigator.storage.persist()`'s answer, once asked; null before (V11). */
  persisted: boolean | null;
  /** Things whose short ID came at sync and can be printed now: "Print pending labels (N)". */
  printPending: number;
  /**
   * The answers that name what changed under an op (D35, T14's `result.notice`): "the drill was
   * trashed by Alfred", oldest first. The status line shows each until the person dismisses it.
   */
  notices: SyncNotice[];
};

/** A notice the status line spells out: a drop whose answer names what changed (T14 sends
 * `notice` with `dropped` only; any other answer is counted in "N changes need a look"). */
export const namesChange = (n: SyncNotice): boolean => n.kind === 'dropped' && !!n.result?.notice;

/** Runs `fn` if this tab may sync now; resolves undefined when another tab is syncing. */
export type SyncLock = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export type EngineOptions = {
  store: SyncStore;
  http?: SyncHttp;
  /** After a 401 wiped the phone's copy: go to the sign-in page (D181). */
  onSignedOut?: () => void;
  /** The build's version, sent with every batch (D148). */
  clientVersion?: string;
  /** For tests: a fake v0 → v1 upgrader, say. */
  upgraders?: UpgraderTable;
  lock?: SyncLock;
  intervalMs?: number;
  blockedRetryMs?: number;
  now?: () => number;
};

const INTERVAL_MS = 60_000;
const BLOCKED_RETRY_MS = 30 * 60_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

const errStatus = (e: unknown) => (e instanceof ApiError ? e.status : undefined);
const isOffline = (e: unknown) => e instanceof ApiError && e.code === 'offline';
const outdatedCode = (e: unknown): 'client_outdated' | 'server_outdated' | null =>
  e instanceof ApiError && (e.code === 'client_outdated' || e.code === 'server_outdated')
    ? e.code
    : null;

/** Exactly the wire fields: the server's schema is strict (SyncOpsRequestSchema). */
function toItem(e: QueueEntry): QueueItem {
  return {
    clientVersion: e.clientVersion,
    payloadVersion: e.payloadVersion,
    clientId: e.clientId,
    idempotencyKey: e.idempotencyKey,
    op: e.op,
    takenAt: e.takenAt,
    locationId: e.locationId,
    ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
    payload: e.payload,
  };
}

const localDrop = (e: QueueEntry, reason: string): SyncOpResult => ({
  clientId: e.clientId,
  idempotencyKey: e.idempotencyKey,
  outcome: 'dropped',
  reason,
});

export class SyncEngine {
  readonly store: SyncStore;
  private readonly http: SyncHttp;
  private readonly opts: EngineOptions;
  private readonly now: () => number;
  private status: SyncStatus = {
    phase: 'idle',
    problem: null,
    lastSyncAt: null,
    asOf: null,
    counts: { waiting: 0, uploading: 0, needsAttention: 0 },
    truncated: false,
    persisted: null,
    printPending: 0,
    notices: [],
  };
  private listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private blockedAt: number | null = null;
  private blockedCode: 'client_outdated' | 'server_outdated' | null = null;
  private persistAsked = false;
  private readonly detach: (() => void)[] = [];

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.http = opts.http ?? defaultHttp;
    this.now = opts.now ?? Date.now;
  }

  // ----- lifecycle -----------------------------------------------------------------------------

  /** App open: listen for the triggers, unblock the queue (a new build may take it), run. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          void this.clearBadge();
          void this.run();
        } else {
          this.clearTimer();
          void this.setBadge();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.detach.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    if (typeof window !== 'undefined') {
      const onOnline = () => void this.run();
      const onOffline = () => this.set({ problem: 'offline' });
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      this.detach.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    }
    await this.unblock();
    await this.run();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.clearTimer();
    for (const d of this.detach.splice(0)) d();
  }

  /** Queues a capture (or any op) and syncs soon; asks for persistent storage the first time. */
  async enqueue(
    item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'>,
    blobs: LocalBlob[],
  ): Promise<void> {
    await this.store.enqueue(item, blobs);
    await this.askPersistence();
    await this.refresh();
    this.kick();
  }

  /** Something else changed the queue: sync soon (once started; tests drive `run()` alone). */
  kick(): void {
    if (this.started) void this.run();
  }

  getStatus = (): SyncStatus => this.status;

  /** The person has read a notice (the status line's ×): it goes, and so does its answered op. */
  async dismissNotice(id: number): Promise<void> {
    await this.store.dismissNotice(id);
    await this.refresh();
  }

  subscribe = (fn: (s: SyncStatus) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /**
   * One sync run. Single-flight: a call during a run makes one more run after it, so nothing
   * enqueued meanwhile waits for the timer.
   */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await (this.opts.lock ?? defaultLock)(() => this.runOnce());
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
        this.schedule();
      }
    })();
    return this.running;
  }

  // ----- one run -------------------------------------------------------------------------------

  private async runOnce(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.set({ problem: 'offline' });
      await this.refresh();
      return;
    }
    let problem: SyncProblem | null = null;
    try {
      if (this.blockedAt !== null && this.now() - this.blockedAt >= this.blockedRetry())
        await this.unblock();
      await this.upgradeQueue();
      this.set({ phase: 'uploading' });
      await this.uploadAll();
      this.set({ phase: 'sending' });
      problem = await this.sendAll();
      this.set({ phase: 'pulling' });
      const pullStart = this.now();
      const pull = await this.pull();
      if (pull.complete) await this.store.pruneApplied(pullStart);
      await this.store.setMeta('lastSyncAt', this.now());
      this.failures = 0;
    } catch (e) {
      if (errStatus(e) === 401) {
        await this.signedOut();
        return;
      }
      if (e instanceof StorageFullError) problem = 'storage_full';
      else if (isOffline(e)) problem = 'offline';
      else {
        problem = 'server';
        this.failures += 1;
      }
    } finally {
      if (!this.stopped) {
        this.set({ phase: 'idle', problem });
        await this.refresh();
      }
    }
  }

  /** D148: payloads an older build queued are brought up to this build's version first. */
  private async upgradeQueue() {
    for (const e of await this.store.pending()) {
      // Only ops the server has provably not applied: a `sent` one may be in its ledger under
      // its current payload, and a changed payload would replay as `idempotency_mismatch`.
      if (e.state !== 'pending' && e.state !== 'blocked') continue;
      const up = upgradeEntry(e, this.opts.upgraders);
      if (up.kind === 'upgraded') await this.store.setPayload(e.seq, up.payload, up.payloadVersion);
    }
  }

  private async uploadAll() {
    const needs = await this.store.unuploadedSeqs();
    if (needs.size === 0) return;
    for (const e of await this.store.pending()) {
      if (!needs.has(e.seq)) continue;
      const outcome = await uploadEntryFiles(this.store, e, this.http);
      // The server refused the file itself: the op can't apply. Visible, never silent (D35).
      if (outcome === 'refused') await this.store.settle(localDrop(e, 'invalid'));
    }
  }

  /** Sends ready ops in order. Answers the blocking problem, if the server refused the batch. */
  private async sendAll(): Promise<SyncProblem | null> {
    let max: number | undefined;
    for (;;) {
      const all = await this.store.entries();
      const byKey = new Map(all.map((e) => [e.idempotencyKey, e.state]));
      const needs = await this.store.unuploadedSeqs();
      const batch = nextBatch(
        all,
        (seq) => !needs.has(seq),
        (k) => byKey.get(k),
        max,
      );
      let send = batch.send;
      for (const e of batch.parentDropped) await this.store.settle(localDrop(e, 'parent_dropped'));
      if (send.length === 0) {
        const blocked = all.some((e) => e.state === 'blocked');
        return blocked ? (this.blockedCode ?? 'client_outdated') : null;
      }
      await this.store.setState(
        send.map((e) => e.seq),
        'sent',
      );
      // Re-read: an op taken back ("Undo this batch", `unqueue`) before it was marked is gone.
      const marked = new Set(send.map((e) => e.seq));
      send = (await this.store.entries()).filter((e) => marked.has(e.seq) && e.state === 'sent');
      if (send.length === 0) continue;
      const seqs = send.map((e) => e.seq);
      let res: SyncOpsResponse;
      try {
        res = await this.http.syncOps({
          clientVersion: this.opts.clientVersion ?? KEPT_VERSION,
          ops: send.map(toItem),
        });
      } catch (e) {
        const outdated = outdatedCode(e);
        if (outdated) {
          // Nothing in the batch was applied; the queue stays, blocked, never dropped (D148).
          await this.store.setState(seqs, 'blocked');
          await this.store.addNotice({ kind: 'outdated' });
          this.blockedAt = this.now();
          this.blockedCode = outdated;
          return outdated;
        }
        if (errStatus(e) === 400) {
          // The batch didn't parse. Find the one op that doesn't, by sending one at a time.
          if (send.length > 1) {
            await this.store.setState(seqs, 'pending');
            max = 1;
            continue;
          }
          const [only] = send;
          if (only) await this.store.settle(localDrop(only, 'invalid'));
          continue;
        }
        // No answer (offline, 5xx, a dropped connection): the server may have applied them, so
        // they stay `sent` (never taken back by `unqueue`, never re-written by an upgrade) and go
        // again next run with the same keys; the server answers a replay from its ledger.
        throw e;
      }
      if (this.blockedCode !== null || this.blockedAt !== null) {
        this.blockedAt = null;
        this.blockedCode = null;
      }
      await this.store.clearOutdated();
      const answered = new Set<string>();
      for (const r of res.results) {
        await this.store.settle(r);
        answered.add(r.idempotencyKey);
      }
      const unanswered = send.filter((e) => !answered.has(e.idempotencyKey));
      if (unanswered.length > 0) {
        // The server stopped part-way (a 500 in one op, T14): the rest go again, same keys.
        await this.store.setState(
          unanswered.map((e) => e.seq),
          'pending',
        );
        throw new ApiError(500, 'internal', 'The server answered part of the batch.');
      }
    }
  }

  /**
   * Pulls the snapshot. A 400 while the phone holds a cursor is a cursor the server no longer
   * verifies (garbled, or signed before KEPT_AUTH_SECRET changed): the copy and the cursor go,
   * the queue stays, and a full pass follows at once. A 400 on that full pass is a server
   * problem, never another reset.
   */
  private async pull(): Promise<PullResult> {
    try {
      return await pullSnapshot(this.store, this.http.snapshot);
    } catch (e) {
      if (errStatus(e) !== 400 || (await this.store.cursor()) === null) throw e;
      await this.store.resetSnapshot();
      return pullSnapshot(this.store, this.http.snapshot);
    }
  }

  // ----- helpers -------------------------------------------------------------------------------

  /** App start, a new build, or the 30-minute retry: blocked entries may go again. */
  private async unblock() {
    const blocked = (await this.store.pending()).filter((e) => e.state === 'blocked');
    if (blocked.length > 0)
      await this.store.setState(
        blocked.map((e) => e.seq),
        'pending',
      );
    this.blockedAt = null;
    this.blockedCode = null;
  }

  private blockedRetry() {
    return this.opts.blockedRetryMs ?? BLOCKED_RETRY_MS;
  }

  private async askPersistence() {
    if (this.persistAsked) return;
    this.persistAsked = true;
    if ((await this.store.meta('persisted')) === true) return;
    const granted = await requestPersistence();
    if (granted !== null) await this.store.setMeta('persisted', granted);
  }

  /** D210: the cache goes at once; the person's own queue stays, locked, for their next sign-in. */
  private async signedOut() {
    this.stop();
    try {
      await this.store.wipeCache();
    } finally {
      this.opts.onSignedOut?.();
    }
  }

  /** The next timed run: back-off after a server failure, the interval otherwise; visible only. */
  private schedule() {
    this.clearTimer();
    if (this.stopped || !this.started) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const delay =
      this.status.problem === 'server'
        ? Math.min(BACKOFF_MIN_MS * 2 ** Math.max(0, this.failures - 1), BACKOFF_MAX_MS)
        : (this.opts.intervalMs ?? INTERVAL_MS);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reads what the status line shows from the store. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    const [counts, asOf, truncated, persisted, lastSyncAt, printPending, notices] =
      await Promise.all([
        this.store.counts(),
        this.store.asOf(),
        this.store.meta('truncated'),
        this.store.meta('persisted'),
        this.store.meta('lastSyncAt'),
        this.store.meta('printPending'),
        this.store.notices(),
      ]);
    this.set({
      counts,
      asOf,
      truncated: truncated === true,
      persisted: typeof persisted === 'boolean' ? persisted : null,
      lastSyncAt: typeof lastSyncAt === 'number' ? lastSyncAt : null,
      printPending: Array.isArray(printPending) ? printPending.length : 0,
      notices: notices.filter(namesChange),
    });
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  /** While hidden with work left, the app icon carries the count (D36; iOS 16.4+ installed). */
  private async setBadge() {
    const n = this.status.counts.waiting + this.status.counts.uploading;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void> };
    try {
      if (n > 0) await nav.setAppBadge?.(n);
    } catch {
      // No permission, or not installed: the in-app line says it instead.
    }
  }

  private async clearBadge() {
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    try {
      await nav.clearAppBadge?.();
    } catch {
      // As above.
    }
  }
}

// ----- the cross-tab lock ------------------------------------------------------------------------

type LockManagerLike = {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    cb: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};

/** Web Locks where there are any (iOS 15.4+), else a BroadcastChannel claim, else just run. */
export const defaultLock: SyncLock = async (fn) => {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (locks) {
    return (await locks.request('kept-sync', { ifAvailable: true }, async (lock) =>
      lock ? fn() : undefined,
    )) as Awaited<ReturnType<typeof fn>> | undefined;
  }
  if (typeof BroadcastChannel !== 'undefined') return channelLock()(fn);
  return fn();
};

let sharedChannelLock: SyncLock | null = null;

/**
 * The fallback: a tab about to sync posts a claim and listens 80 ms. A tab that is syncing
 * answers "busy"; of two tabs claiming at once, the lower id goes first. The loser skips this
 * run; its timer or the next trigger tries again.
 */
function channelLock(): SyncLock {
  if (sharedChannelLock) return sharedChannelLock;
  const ch = new BroadcastChannel('kept-sync');
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let held = false;
  let claiming = false;
  let lost = false;
  ch.onmessage = (m: MessageEvent<{ type: string; id: string; to?: string }>) => {
    const msg = m.data;
    if (msg.type === 'claim') {
      if (held) ch.postMessage({ type: 'busy', id, to: msg.id });
      else if (claiming && msg.id < id) lost = true;
    } else if (msg.type === 'busy' && msg.to === id) lost = true;
  };
  sharedChannelLock = async (fn) => {
    claiming = true;
    lost = false;
    ch.postMessage({ type: 'claim', id });
    await new Promise((r) => setTimeout(r, 80));
    claiming = false;
    if (lost) return undefined;
    held = true;
    try {
      return await fn();
    } finally {
      held = false;
    }
  };
  return sharedChannelLock;
}
