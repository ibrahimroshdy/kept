/**
 * Capture and inbox vocabulary (D34, D175, D191; engineering spec §7.8; screens §5 and §8).
 * The database CHECKs (0027's `extractions.mode`, `inbox_items.kind` and `.resolution`), the
 * zod schemas and the web read these lists.
 */

/** The camera's mode strip, THING · RECEIPT · LABEL · READING (D34). */
export const CAPTURE_MODES = ['thing', 'receipt', 'label', 'reading'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type PhotoPolicy =
  | { readonly keepOriginal: false; readonly shrinkTo: number }
  | { readonly keepOriginal: true; readonly displayTo: number };

/**
 * What the phone does with a captured photo (D34, §3.4 "display 2048 px"). THING photos are
 * shrunk on the phone and the original is not kept; the evidence modes keep the original
 * byte-identical (D117) and add a display derivative.
 */
export const PHOTO_POLICY: Readonly<Record<CaptureMode, PhotoPolicy>> = Object.freeze({
  thing: { shrinkTo: 2048, keepOriginal: false },
  receipt: { keepOriginal: true, displayTo: 2048 },
  label: { keepOriginal: true, displayTo: 2048 },
  reading: { keepOriginal: true, displayTo: 2048 },
});

/** `inbox_items.kind` (§7.8). */
export const INBOX_KINDS = [
  'draft',
  'reading',
  'label_claim',
  'currency',
  'duplicate',
  'receipt',
  'sync_drop',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** `inbox_items.resolution`: how an item left the inbox (plan T5, T15). */
export const INBOX_RESOLUTIONS = [
  'accepted',
  'edited',
  'discarded',
  'merged',
  'linked',
  'restored',
  'dismissed',
] as const;
export type InboxResolution = (typeof INBOX_RESOLUTIONS)[number];

/**
 * The inbox's fixed keyboard map (D175; screens §5 "Keyboard" and §8 "Inbox keys"). Keys are
 * written the way the web's key handler compares them: lower case, `shift+` for the modifier.
 */
export const INBOX_KEYMAP = Object.freeze({
  j: 'next',
  k: 'previous',
  a: 'accept',
  e: 'edit',
  m: 'move',
  t: 'set_type',
  x: 'select',
  'shift+a': 'accept_selected',
  l: 'link_receipt_line',
  s: 'split',
  g: 'merge',
  d: 'drop',
  y: 'confirm_field',
  n: 'reject_field',
} as const);
export type InboxKey = keyof typeof INBOX_KEYMAP;
export type InboxAction = (typeof INBOX_KEYMAP)[InboxKey];
