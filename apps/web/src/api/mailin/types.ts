/**
 * Email-in's types (1.4, D231), as `apps/server/src/mailin/routes.ts` answers them. The password
 * is write-only: sent in a PUT, never answered.
 */

export type ImapSecurity = 'tls' | 'starttls';

/** Why a sign-in failed (`mailError` on the PUT's 400, `error` on a check, `lastError`). */
export type MailError =
  | 'private_address'
  | 'unreachable'
  | 'tls_failed'
  | 'auth_failed'
  | 'no_folder'
  | 'timeout'
  | 'failed'
  | 'creator_left';

export type Mailbox = {
  id: string;
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  folder: string;
  allowedSenders: string[];
  active: boolean;
  /** Why it turned itself off: its creator stopped administering the location, or the server
   * refused the password. Saving it turns it back on. */
  disabledReason: 'creator_left' | 'auth_failed' | null;
  lastPolledAt: string | null;
  lastError: string | null;
  createdBy: { id: string; displayName: string };
};

export type MailOutcome = 'receipt' | 'no_receipt' | 'sender_not_allowed' | 'too_large' | 'failed';

export type RecentMail = {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: string | null;
  outcome: MailOutcome;
  /** The draft receipt it became. */
  purchaseId: string | null;
  at: string;
};

export type MailboxResponse = { mailbox: Mailbox | null; recent: RecentMail[] };

export type MailboxBody = {
  host: string;
  port?: number;
  security: ImapSecurity;
  username: string;
  /** Required the first time; left out, the saved one is kept. */
  password?: string;
  folder: string;
  allowedSenders: string[];
};

export type MailboxCheck = { ok: boolean; error: MailError | null };
