import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '@kept/shared';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { capture } from '../capture/service.js';
import type { Keyring, Sealed } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope, withSystem } from '../db/scope.js';
import { ingestFile } from '../files/ingest.js';
import { AppError } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { renderPdf, writeData } from '../reports/render/render.js';
import type { FileStorage } from '../storage/blob-store.js';
import { ImageLimiter } from '../storage/derivatives.js';
import { openMailboxConfig } from './config.js';
import { type ReadMail, readMail } from './read.js';
import { type MailSession, type MailSource, MailSourceError } from './source.js';

// The `mail-in` job (1.4, D231): every 10 minutes, each active mailbox's new mail becomes draft
// receipts, as a RECEIPT capture made by the person who connected the mailbox.
//
// - The first poll of a folder (or one whose UIDVALIDITY changed) only sets the mark: mail that
//   was already there is never read, only mail that arrives after.
// - At most MAX_PER_POLL messages a poll, oldest first; the rest wait for the next one.
// - A message's attached photos and PDFs are its receipt's pages. With none, its body becomes a
//   one-page PDF (reports/template/email.typ), so the receipt prompt reads its text (pdf-text).
//   A message with neither, from a sender the mailbox doesn't allow, or past MAX_MESSAGE_BYTES,
//   is recorded and skipped.
// - The capture runs in the creator's scope: their rights, the location's AI budget (D121), and
//   the capture's own audit (`purchase.capture`). If they no longer administer the location
//   (they can't see the mailbox), the mailbox turns off (`creator_left`, as D180 does for a
//   webhook); a refused sign-in turns it off too (`auth_failed`), so a wrong password isn't tried
//   every 10 minutes until the server locks the account. Saving the mailbox turns it back on.
// - Every message read is recorded in mailbox_messages (the page's recent mail), and the mark
//   moves past it, so a failure isn't retried forever; records past 90 days are removed.

export const MAIL_IN_JOB = 'mail-in';
export const MAX_PER_POLL = 20;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** A mailbox polled more recently than this is left for the next run. */
const POLL_GAP_MINUTES = 9;

export type MailInDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage | null;
  keyring: Keyring | null;
  source: MailSource;
  /** The worker's tenant sender: the receipt's extraction and a PDF's text. */
  sendTenant?: (
    client: import('pg').ClientBase,
    name: string,
    data: object,
    options: { startAfter: Date },
  ) => Promise<void>;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

type Due = {
  id: string;
  location_id: string;
  created_by: string;
  allowed_senders: string[];
  uid_validity: number | null;
  last_uid: number | null;
};

export type PollOutcome = { mailbox: string; read: number; receipts: number; error?: string };

/** The jobs' sender as a JobQueue, for capture() and ingestFile(). */
function queueOf(deps: MailInDeps): JobQueue | null {
  const send = deps.sendTenant;
  if (!send) return null;
  return {
    send: async () => {
      throw new Error('mail-in sends only tenant jobs');
    },
    sendTenant: (client, name, data, dedupe) =>
      send(client, name, data, {
        startAfter: new Date(Date.now() + (dedupe?.startAfter ?? 0) * 1000),
      }),
  };
}

async function setMailbox(
  deps: MailInDeps,
  id: string,
  u: {
    uidValidity?: number;
    lastUid?: number;
    error?: string | null;
    off?: 'creator_left' | 'auth_failed';
    polled?: boolean;
  },
): Promise<void> {
  await withSystem(deps.pools.system, (_tx, c) =>
    c.query(
      `UPDATE public.mailboxes
          SET uid_validity = coalesce($2::bigint, uid_validity),
              last_uid = coalesce($3::bigint, last_uid),
              last_error = CASE WHEN $4::boolean THEN $5 ELSE last_error END,
              active = CASE WHEN $6::text IS NULL THEN active ELSE false END,
              disabled_reason = coalesce($6, disabled_reason),
              last_polled_at = CASE WHEN $7::boolean THEN now() ELSE last_polled_at END
        WHERE id = $1`,
      [
        id,
        u.uidValidity ?? null,
        u.lastUid ?? null,
        u.error !== undefined,
        u.error ?? null,
        u.off ?? null,
        u.polled === true,
      ],
    ),
  );
}

async function record(
  deps: MailInDeps,
  m: Due,
  uidValidity: number,
  uid: number,
  mail: Pick<ReadMail, 'from' | 'subject' | 'date'> | null,
  outcome: 'receipt' | 'no_receipt' | 'sender_not_allowed' | 'too_large' | 'failed',
  purchaseId: string | null,
): Promise<void> {
  await withSystem(deps.pools.system, (_tx, c) =>
    c.query(
      `INSERT INTO public.mailbox_messages (location_id, mailbox_id, uid_validity, uid,
                                            from_address, subject, received_at, outcome,
                                            purchase_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING`,
      [
        m.location_id,
        m.id,
        uidValidity,
        uid,
        mail?.from ?? null,
        mail?.subject ?? null,
        mail?.date ?? null,
        outcome,
        purchaseId,
      ],
    ),
  );
}

/** The files one message gives its receipt, written to `dir`: its attachments, or its body. */
async function receiptFiles(
  mail: ReadMail,
  dir: string,
): Promise<{ file: string; bytes: Buffer }[]> {
  if (mail.files.length > 0) {
    return Promise.all(
      mail.files.map(async (f) => {
        const file = path.join(dir, newId());
        await writeFile(file, f.bytes);
        return { file, bytes: f.bytes };
      }),
    );
  }
  if (!mail.body) return [];
  const job = await mkdtemp(path.join(dir, 'email-'));
  await writeData(job, {
    subject: mail.subject ?? '',
    from: mail.from ?? '',
    date: mail.date ? mail.date.toUTCString() : '',
    paragraphs: mail.body,
  });
  const out = await renderPdf(job, {}, 'email');
  const { readFile } = await import('node:fs/promises');
  return [{ file: out.file, bytes: await readFile(out.file) }];
}

/** One message: its files ingested and its receipt captured, as the mailbox's creator. */
async function captureMail(
  deps: MailInDeps & { files: FileStorage },
  scope: Scope,
  m: Due,
  mail: ReadMail,
  dir: string,
): Promise<string | null> {
  const parts = await receiptFiles(mail, dir);
  if (parts.length === 0) return null;
  const jobs = queueOf(deps);
  const limiter = new ImageLimiter(Math.max(1, deps.files.imageConcurrency));
  const fileIds: string[] = [];
  for (const p of parts) {
    const up = await ingestFile(
      { pools: deps.pools, files: deps.files, limiter, log: deps.log, jobs },
      scope,
      {
        file: p.file,
        sha256: createHash('sha256').update(p.bytes).digest('hex'),
        bytes: p.bytes.length,
        fileId: newId(),
        locationId: m.location_id,
        class: 'evidence',
      },
      { requestId: null },
    );
    fileIds.push(up.body.id);
  }
  const id = newId();
  const result = await withScope(deps.pools.app, scope, (tx, client) =>
    capture(
      { tx, client, scope, requestId: `mail-in-${m.id}`.slice(0, 64), jobs, files: deps.files },
      {
        id,
        locationId: m.location_id,
        target: { unplaced: true },
        mode: 'receipt',
        batchId: newId(),
        files: [...new Set(fileIds)].map((fileId) => ({ fileId, role: 'receipt' as const })),
        ...(mail.subject ? { note: mail.subject.slice(0, 500) } : {}),
      },
      { via: 'op' },
    ),
  );
  return result.purchaseId ?? id;
}

/** Polls one mailbox. Never throws: a failure is the mailbox's `last_error`. */
export async function pollMailbox(deps: MailInDeps, m: Due): Promise<PollOutcome> {
  const out: PollOutcome = { mailbox: m.id, read: 0, receipts: 0 };
  const scope: Scope = { userId: m.created_by, mfa: false };
  // The creator still administers the location: the mailbox is visible to them (0120).
  const visible = await withScope(deps.pools.app, scope, async (_tx, c) => {
    const { rows } = await c.query('SELECT 1 FROM public.mailboxes WHERE id = $1', [m.id]);
    return rows.length > 0;
  }).catch(() => false);
  if (!visible) {
    await setMailbox(deps, m.id, { off: 'creator_left', error: 'creator_left', polled: true });
    return { ...out, error: 'creator_left' };
  }
  if (!deps.keyring || !deps.files) return { ...out, error: 'not_configured' };
  const files = deps.files;
  const sealed = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<{ config_ciphertext: Sealed }>(
      'SELECT config_ciphertext FROM kept.mailbox_config($1)',
      [m.id],
    );
    return rows[0]?.config_ciphertext ?? null;
  });
  if (!sealed) return { ...out, error: 'missing' };

  let session: MailSession;
  try {
    const config = openMailboxConfig(deps.keyring, m.id, sealed);
    session = await deps.source(config, { allowPrivate: await allowPrivateAddresses(deps.pools) });
  } catch (e) {
    const code = e instanceof MailSourceError ? e.code : 'failed';
    if (code === 'failed') deps.log.error({ err: e, mailbox: m.id }, 'mail-in: connection failed');
    await setMailbox(deps, m.id, {
      error: code,
      polled: true,
      ...(code === 'auth_failed' ? { off: 'auth_failed' as const } : {}),
    });
    return { ...out, error: code };
  }

  await mkdir(files.tmpDir, { recursive: true });
  const dir = await mkdtemp(path.join(files.tmpDir, 'mail-in-'));
  try {
    const folder = session.folder();
    if (m.uid_validity !== folder.uidValidity || m.last_uid === null) {
      // The first poll, or the folder was recreated: from now on.
      await setMailbox(deps, m.id, {
        uidValidity: folder.uidValidity,
        lastUid: Math.max(0, folder.uidNext - 1),
        error: null,
        polled: true,
      });
      return out;
    }
    const refs = (await session.list(m.last_uid)).slice(0, MAX_PER_POLL);
    for (const ref of refs) {
      out.read += 1;
      let mail: ReadMail | null = null;
      let outcome: Parameters<typeof record>[5] = 'failed';
      let purchaseId: string | null = null;
      try {
        if (ref.size > MAX_MESSAGE_BYTES) outcome = 'too_large';
        else {
          const raw = await session.source(ref.uid);
          if (raw) {
            mail = await readMail(raw);
            if (
              m.allowed_senders.length > 0 &&
              !(mail.from && m.allowed_senders.includes(mail.from))
            ) {
              outcome = 'sender_not_allowed';
            } else {
              purchaseId = await captureMail({ ...deps, files }, scope, m, mail, dir);
              outcome = purchaseId ? 'receipt' : 'no_receipt';
              if (purchaseId) out.receipts += 1;
            }
          } else outcome = 'no_receipt';
        }
      } catch (e) {
        if (e instanceof AppError && (e.status === 403 || e.status === 404)) {
          // The creator lost the location between the check and the capture.
          await setMailbox(deps, m.id, {
            off: 'creator_left',
            error: 'creator_left',
            polled: true,
          });
          return { ...out, error: 'creator_left' };
        }
        deps.log.error({ err: e, mailbox: m.id, uid: ref.uid }, 'mail-in: a message failed');
      }
      await record(deps, m, folder.uidValidity, ref.uid, mail, outcome, purchaseId);
      await setMailbox(deps, m.id, { lastUid: ref.uid });
    }
    await setMailbox(deps, m.id, { error: null, polled: true });
    return out;
  } catch (e) {
    const code = e instanceof MailSourceError ? e.code : 'failed';
    deps.log.error({ err: e, mailbox: m.id }, 'mail-in: the poll failed');
    await setMailbox(deps, m.id, { error: code, polled: true });
    return { ...out, error: code };
  } finally {
    await session.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/** One run: every active mailbox due a poll, one at a time; then the old records go. */
export async function runMailIn(deps: MailInDeps): Promise<PollOutcome[]> {
  const due = await withSystem(deps.pools.system, async (_tx, c) => {
    const { rows } = await c.query<Due>(
      `SELECT m.id, m.location_id, m.created_by, m.allowed_senders,
              m.uid_validity::float8 AS uid_validity, m.last_uid::float8 AS last_uid
         FROM public.mailboxes m JOIN public.locations l ON l.id = m.location_id
        WHERE m.active AND l.deleted_at IS NULL
          AND (m.last_polled_at IS NULL
               OR m.last_polled_at < now() - make_interval(mins => $1))
        ORDER BY m.last_polled_at NULLS FIRST, m.id
        LIMIT 100`,
      [POLL_GAP_MINUTES],
    );
    return rows;
  });
  const outcomes: PollOutcome[] = [];
  for (const m of due) outcomes.push(await pollMailbox(deps, m));
  await withSystem(deps.pools.system, (_tx, c) =>
    c.query(`DELETE FROM public.mailbox_messages WHERE created_at < now() - interval '90 days'`),
  );
  return outcomes;
}
