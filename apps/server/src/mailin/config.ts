import { isIP } from 'node:net';
import { z } from 'zod';
import {
  type Aad,
  type Keyring,
  type MasterKey,
  open,
  type Sealed,
  seal,
} from '../crypto/envelope.js';

// A mailbox's IMAP connection (1.4, D231): sealed together as `mailboxes|<id>|config` (§7.3), so
// the password never sits in the clear and kept_app never reads it (0120). The host and user
// name are also kept in the clear for the settings page; the folder too, as the job's mark is
// per folder.

export const IMAP_PORTS = { tls: 993, starttls: 143 } as const;
export const MAX_ALLOWED_SENDERS = 20;

/** `tls`: TLS from the first byte (993); `starttls`: plain, then STARTTLS, required (143). There
 * is no unencrypted choice: a mailbox password never crosses the network in the clear. */
export const IMAP_SECURITY = ['tls', 'starttls'] as const;
export type ImapSecurity = (typeof IMAP_SECURITY)[number];

export type MailboxConfig = {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
  folder: string;
};

export const mailboxAad = (mailboxId: string): Aad => ({
  table: 'mailboxes',
  rowId: mailboxId,
  fieldKey: 'config',
});

export function sealMailboxConfig(master: MasterKey, id: string, config: MailboxConfig): Sealed {
  return seal(master, JSON.stringify(config), mailboxAad(id));
}

export function openMailboxConfig(keyring: Keyring, id: string, sealed: Sealed): MailboxConfig {
  const parsed = JSON.parse(open(keyring, sealed, mailboxAad(id)).toString('utf8'));
  return {
    host: String(parsed.host),
    port: Number(parsed.port),
    security: parsed.security === 'starttls' ? 'starttls' : 'tls',
    username: String(parsed.username),
    password: String(parsed.password),
    folder: String(parsed.folder),
  };
}

/** A host name or an IP address; no scheme, port or path. */
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const MailboxHost = z
  .string()
  .trim()
  .toLowerCase()
  .refine((h) => HOST.test(h) || isIP(h) !== 0, 'host: a host name, like imap.example.com.');

export const Sender = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** The settings' folder: IMAP names are free text, but not control characters. */
export const Folder = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (f) => ![...f].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch === '\u007f'),
    'folder: no control characters.',
  );
