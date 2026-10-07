// Homebox's type icons as Kept's (D146 "icons matched by name where possible"; spike H2,
// docs/spikes/2026-09-30-step7-homebox.md). Homebox v0.26.2's picker offers exactly these 16
// names (frontend/lib/icons.ts); each Lucide name was checked against lucide-react 1.48.0.
// Anything else (the API stores any string) is dropped with `hb_icon_dropped`, and the Kept
// type keeps its own icon; null or "" is no icon, with no issue.

export const HB_ICONS: Readonly<Record<string, string>> = Object.freeze({
  'tag-outline': 'lucide:tag',
  'tree-outline': 'lucide:tree-deciduous',
  'bag-suitcase-outline': 'lucide:luggage',
  'bed-outline': 'lucide:bed',
  'kitchen-counter-outline': 'lucide:cooking-pot',
  'book-open-variant-outline': 'lucide:book-open',
  laptop: 'lucide:laptop',
  'sofa-outline': 'lucide:sofa',
  'toolbox-outline': 'lucide:toolbox',
  'file-cabinet-outline': 'lucide:folder',
  'dresser-outline': 'lucide:archive',
  'lightbulb-outline': 'lucide:lightbulb',
  'power-plug-outline': 'lucide:plug',
  'wrench-outline': 'lucide:wrench',
  dumbbell: 'lucide:dumbbell',
  'palette-outline': 'lucide:palette',
});

/** A new Kept type's icon when Homebox's is none or unknown: the built-in box's. */
export const DEFAULT_TYPE_ICON = 'lucide:package';

/** The Kept icon for a Homebox one, and whether Homebox's was dropped. */
export function keptIcon(icon: string | null | undefined): { icon: string; dropped: boolean } {
  const name = icon?.trim() ?? '';
  if (!name) return { icon: DEFAULT_TYPE_ICON, dropped: false };
  const mapped = HB_ICONS[name];
  return mapped ? { icon: mapped, dropped: false } : { icon: DEFAULT_TYPE_ICON, dropped: true };
}
