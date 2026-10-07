/**
 * Outbound webhooks (D63, D110, D172, D180; engineering spec §2.6, §3.1b). Payloads carry ids and
 * changed field names, never values: a receiver fetches the entity with its own token.
 */

export const WEBHOOK_EVENTS = [
  'thing.created',
  'thing.updated',
  'thing.moved',
  'thing.trashed',
  'thing.restored',
  'thing.lifecycle_changed',
  'reading.logged',
  'reminder.due',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookPayload = {
  /** `evt_` and 10 to 40 letters and digits. */
  id: string;
  event: WebhookEvent | 'ping';
  occurred_at: string;
  location_id: string;
  entity: { type: 'thing' | 'reading' | 'reminder' | 'webhook'; id: string };
  changed_fields: string[];
  actor: { type: 'user' | 'token' | 'system'; id: string | null };
};

export const WEBHOOK_EVENT_ID = /^evt_[A-Za-z0-9]{10,40}$/;

/** `Kept-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export const SIGNATURE_HEADER = 'Kept-Signature';

/** The string a signature is the HMAC of. */
export function signedContent(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function formatSignature(timestamp: number, hexMac: string): string {
  return `t=${timestamp},v1=${hexMac}`;
}

/** The header's timestamp and v1 MAC, or null when it isn't one. */
export function parseSignature(header: string): { t: number; v1: string } | null {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  return m?.[1] && m[2] ? { t: Number(m[1]), v1: m[2] } : null;
}

/** 10 attempts over 24 hours, then `gave_up`; at most 10 deliveries a second per location. */
export const WEBHOOK_LIMITS = Object.freeze({
  attempts: 10,
  windowHours: 24,
  perSecondPerLocation: 10,
});

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'gave_up'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_DISABLED_REASONS = ['creator_lost_role', 'failing', 'admin'] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];
