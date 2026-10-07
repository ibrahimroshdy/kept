import type { AiCapFacts, MailBody, MailKind } from './mailer.js';

// The shapes and helpers every language's mail table shares (messages.ts and messages-<locale>.ts).

export type Message = {
  subject: string;
  /** The body, one paragraph each. */
  paragraphs: string[];
  /** The one thing to do, as a button (and its address, spelled out, in the text part). */
  action?: { label: string; url: string };
  /** Small print under the action: why you got this, what to do if it wasn't you. */
  footnote?: string;
};

/** The parts every mail shares. */
export type Chrome = {
  dir: 'ltr' | 'rtl';
  /** Above a link spelled out, for when the button doesn't work. */
  linkFallback: string;
  /** The last line: which Kept sent it. */
  sentBy: (host: string) => string;
};

export type MessageContext = {
  /** KEPT_PUBLIC_URL: the pages a mail points at (never a token; those come in the mail). */
  publicUrl: string;
};

export type Of<K extends MailKind> = Extract<MailBody, { kind: K }>;
export type Table = { [K in MailKind]: (mail: Of<K>, ctx: MessageContext) => Message };

/** Step 4's kinds, whose five languages live together in messages-notify.ts. */
export type NotifyMailKind =
  | 'reminder'
  | 'reminder-digest'
  | 'membership-ended'
  | 'channel-test'
  | 'channel-failing'
  | 'ai-summary';
export type NotifyTable = Pick<Table, NotifyMailKind>;
/** Step 6's D180 configuration notices, whose five languages live in messages-transparency.ts. */
export type TransparencyMailKind = 'oidc-changed' | 'smtp-changed' | 'ai-provider-changed';
export type TransparencyTable = Pick<Table, TransparencyMailKind>;
/** What each language's own table holds: every kind but step 4's and step 6's notices. */
export type CoreTable = Omit<Table, NotifyMailKind | TransparencyMailKind>;

export const page = (ctx: MessageContext, path: string) => new URL(path, ctx.publicUrl).toString();

/** A date as YYYY-MM-DD, from an ISO string or a Date; '' for anything else. */
export function day(value: unknown): string {
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}
export const num = (value: unknown) =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0;

/** A `disk_space_low` alert's figures (step 8 T10): how full, in whole percent, and the free
 * space in gigabytes with one decimal, `comma` for the languages that write `1,5`. */
export function diskFacts(details: Record<string, unknown>, comma = false) {
  const percent = Math.round(num(details.usedRatio) * 100);
  const gb = (num(details.freeBytes) / 1e9).toFixed(1);
  return { percent, gb: comma ? gb.replace('.', ',') : gb, backup: details.volume === 'backup' };
}

// ---------------------------------------------------------------------------------------------
// AI caps (D206): the pieces each language's `ai-cap` mail and AI admin alerts share.
// ---------------------------------------------------------------------------------------------

/** Where a cap is managed: the admin's AI page for the instance's caps, else AI settings. */
export const aiPage = (ctx: MessageContext, scope: AiCapFacts['scope']) =>
  page(ctx, scope === 'instance' || scope === 'instance_account' ? '/admin/ai' : '/settings/ai');

/** The cap facts an AI admin alert carries in its payload, or null. */
export function capFactsOf(details: Record<string, unknown>): AiCapFacts | null {
  const d = details as Partial<AiCapFacts>;
  if (typeof d.scope !== 'string' || typeof d.used !== 'string' || typeof d.limit !== 'string')
    return null;
  return {
    scope: d.scope,
    target: typeof d.target === 'string' ? d.target : '',
    unit: d.unit === 'money' ? 'money' : 'tokens',
    used: d.used,
    limit: d.limit,
    currency: typeof d.currency === 'string' ? d.currency : null,
    pausedUntil: typeof d.pausedUntil === 'string' ? d.pausedUntil : null,
  };
}

/** A token count grouped for a language (Arabic mail keeps Western digits). */
export const tokens = (tag: string, value: string) =>
  new Intl.NumberFormat(tag === 'ar' ? 'en' : tag).format(Number(value) || 0);

/** A phrase with its first letter capitalised, for the start of a sentence. */
export const capitalise = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
