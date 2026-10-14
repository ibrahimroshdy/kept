import { isIP } from 'node:net';
import { AuthenticationFailure, ImapFlow } from 'imapflow';
import { guardedLookup, isPrivateAddress, PrivateAddressError, type Resolve } from '../net/ssrf.js';
import type { MailboxConfig } from './config.js';

// Where the mail-in job reads mail from (1.4, D231). The job and the settings' connection check
// use this port; imapflow is its one real implementation, and the tests use a fake one.
//
// Read-only: the folder is opened with EXAMINE, so nothing is marked read, moved or deleted, and
// the job keeps its own mark (UIDVALIDITY and the last UID read, mailboxes 0119).
//
// The host is a user-supplied outbound target (D128): its address is checked at connect time by
// net/ssrf.ts guardedLookup(), so a private address is refused unless the instance allows them
// (Admin → Settings, `ssrf_allow_private`), and a DNS answer can't change between the check and
// the connection. TLS checks the certificate against the host name.

/** What the folder holds, as far as the job needs: its UIDVALIDITY and the next UID. */
export type FolderState = { uidValidity: number; uidNext: number };

/** One message's UID and size, for the job to choose what to fetch. */
export type MessageRef = { uid: number; size: number };

export interface MailSession {
  folder(): FolderState;
  /** The messages with a UID above `afterUid`, oldest first. */
  list(afterUid: number): Promise<MessageRef[]>;
  /** The message's raw RFC 5322 source, or null when it has gone. */
  source(uid: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export type MailSource = (
  config: MailboxConfig,
  opts: { allowPrivate: boolean },
) => Promise<MailSession>;

/** How a connection failed, in the words the settings page and `last_error` use. */
export type MailErrorCode =
  | 'private_address'
  | 'unreachable'
  | 'tls_failed'
  | 'auth_failed'
  | 'no_folder'
  | 'timeout'
  | 'failed';

export class MailSourceError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MailSourceError';
  }
}

const TIMEOUT_MS = 20_000;

/** The MailErrorCode for whatever imapflow or the socket threw. */
export function mailErrorOf(e: unknown): MailErrorCode {
  for (
    let c: unknown = e, i = 0;
    c && i < 6;
    c = (c as { cause?: unknown; _err?: unknown }).cause ?? (c as { _err?: unknown })._err, i++
  ) {
    if (c instanceof PrivateAddressError) return 'private_address';
  }
  const err = e as { code?: unknown; authenticationFailed?: unknown };
  const code = typeof err?.code === 'string' ? err.code : '';
  if (e instanceof AuthenticationFailure || err?.authenticationFailed === true)
    return 'auth_failed';
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  ) {
    return 'unreachable';
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ETIMEOUT' ||
    code === 'CONNECT_TIMEOUT' ||
    code === 'GREETING_TIMEOUT' ||
    code === 'UPGRADE_TIMEOUT'
  ) {
    return 'timeout';
  }
  if (
    code.startsWith('ERR_TLS') ||
    code.includes('CERT') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'STARTTLS_INJECTION' ||
    /STARTTLS/.test(String((e as Error)?.message ?? ''))
  ) {
    return 'tls_failed';
  }
  return 'failed';
}

/** The real source: imapflow, read-only, through the SSRF guard. `resolve` is for tests. */
export function imapSource(resolve?: Resolve): MailSource {
  return async (config, { allowPrivate }) => {
    if (!allowPrivate && isIP(config.host) !== 0 && isPrivateAddress(config.host)) {
      throw new MailSourceError('private_address', 'That address is on a private network.');
    }
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      doSTARTTLS: config.security === 'starttls' ? true : undefined,
      auth: { user: config.username, pass: config.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS * 3,
      // Passed to net.connect / tls.connect as they are (imapflow connect()).
      tls: allowPrivate ? {} : { lookup: guardedLookup(resolve) },
    } as ConstructorParameters<typeof ImapFlow>[0]);
    // An error after connect (a dropped socket) surfaces on the next call; without a listener it
    // would be an uncaught 'error' event.
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (e) {
      client.close();
      throw new MailSourceError(mailErrorOf(e), 'Could not sign in to the mailbox.');
    }
    let state: FolderState;
    try {
      const box = await client.mailboxOpen(config.folder, { readOnly: true });
      state = { uidValidity: Number(box.uidValidity), uidNext: box.uidNext };
    } catch (e) {
      await client.logout().catch(() => client.close());
      throw new MailSourceError(
        (e as { serverResponseCode?: unknown })?.serverResponseCode === 'NONEXISTENT' ||
          /mailbox|folder|exist/i.test(String((e as Error)?.message ?? ''))
          ? 'no_folder'
          : mailErrorOf(e),
        'Could not open the folder.',
      );
    }
    return {
      folder: () => state,
      list: async (afterUid) => {
        const out: MessageRef[] = [];
        // `N:*` always names the newest message, even one below N: keep only those above.
        for await (const m of client.fetch(
          `${afterUid + 1}:*`,
          { uid: true, size: true },
          { uid: true },
        )) {
          if (m.uid > afterUid) out.push({ uid: m.uid, size: m.size ?? 0 });
        }
        return out.sort((a, b) => a.uid - b.uid);
      },
      source: async (uid) => {
        const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        return m ? (m.source ?? null) : null;
      },
      close: async () => {
        await client.logout().catch(() => client.close());
      },
    };
  };
}
