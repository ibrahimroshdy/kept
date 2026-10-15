/**
 * First-use hint keys, remembered per user on the server (D138; `user_hints`, `PUT
 * /api/v1/me/hints/:key`). `installed_standalone` is shared with step 2's Home checklist, which
 * reads it to tick "Install on your phone".
 *
 * The guided tour's progress (D242) is one key per section, `help.tour.<section>`: dismissed
 * once the person moved past that section, restored (dismissed: false) when the tour starts
 * over. Help resumes at the first section not dismissed.
 */
export const TOUR_SECTION_IDS = [
  'home',
  'capture',
  'inbox',
  'location',
  'search',
  'labels',
  'more',
  'settings',
  'finish',
] as const;
export type TourSectionId = (typeof TOUR_SECTION_IDS)[number];

/** The hint key that remembers a tour section was passed. */
export const tourProgressKey = <S extends TourSectionId>(section: S): `help.tour.${S}` =>
  `help.tour.${section}`;

export const HINT_KEYS = [
  'capture.mode_strip',
  'inbox.suggested',
  'labels.first_print',
  'scan.first_open',
  'help.tour_seen',
  'ai_settings_opened',
  'installed_standalone',
  ...TOUR_SECTION_IDS.map(tourProgressKey),
] as const;
export type HintKey = (typeof HINT_KEYS)[number];

export function isHintKey(value: string): value is HintKey {
  return (HINT_KEYS as readonly string[]).includes(value);
}
