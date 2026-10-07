// Waiting for Postgres at boot (step-8 plan T24, operations review). A server that starts while
// its database is still starting, restarting, or too loaded to answer a new connection in time
// used to exit on the first refusal: pg-boss gives up on a connection after 10 s ("timeout
// exceeded when trying to connect"), seen with the box's load around 30. Under Compose and
// Kubernetes the container restarts and tries again, but a restart loop is slower and noisier than
// waiting, and with no restart policy (a plain `node dist/main.js`) Kept simply stayed down.
//
// Only the start's first contacts retry, and only on errors that mean "not reachable yet":
// refused, reset or timed-out connections, Postgres's "starting up" (57P03) and "too many
// connections" (53300), and the connection-failure class 08. Anything else (a wrong password, a
// missing database, the downgrade guard) still stops the start at once, as before.

type BootLog = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  '57P03', // cannot_connect_now: the database is starting up or shutting down
  '53300', // too_many_connections
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08006', // connection_failure
]);

const TRANSIENT_MESSAGES =
  /timeout exceeded when trying to connect|connection terminated (unexpectedly|due to connection timeout)|the database system is (starting up|shutting down|in recovery mode)/i;

/** Whether an error means the database isn't reachable yet (worth waiting for), not a fault. */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  if (TRANSIENT_MESSAGES.test(err.message)) return true;
  // pg-boss and pg wrap some failures; AggregateError (dual-stack connect) carries the causes.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err && isTransientDbError(cause)) return true;
  const errors = (err as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.some((e) => isTransientDbError(e));
}

/** The waits between attempts: about two minutes in all before the start gives up. */
export const BOOT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 30_000, 30_000];

/**
 * Runs `fn`, and again after each of `delays` while it fails with a transient database error.
 * The last failure, or any other error, is thrown. Each retry is one warning line.
 */
export async function retryAtBoot<T>(
  what: string,
  fn: () => Promise<T>,
  opts: {
    log: BootLog;
    delays?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const delays = opts.delays ?? BOOT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = delays[attempt];
      if (wait === undefined || !isTransientDbError(err)) throw err;
      opts.log.warn(
        { err, attempt: attempt + 1, retryInMs: wait },
        `the database isn't answering yet (${what}); trying again`,
      );
      await sleep(wait);
    }
  }
}
