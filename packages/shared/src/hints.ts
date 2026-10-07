/**
 * First-use hint keys, remembered per user on the server (D138; `user_hints`, `PUT
 * /api/v1/me/hints/:key`). `installed_standalone` is shared with step 2's Home checklist, which
 * reads it to tick "Install on your phone".
 */
export const HINT_KEYS = [
  'capture.mode_strip',
  'inbox.suggested',
  'labels.first_print',
  'scan.first_open',
  'help.tour_seen',
  'ai_settings_opened',
  'installed_standalone',
] as const;
export type HintKey = (typeof HINT_KEYS)[number];

export function isHintKey(value: string): value is HintKey {
  return (HINT_KEYS as readonly string[]).includes(value);
}
