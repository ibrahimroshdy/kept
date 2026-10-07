/**
 * An old label opened in Kept (D146; plan T20): a Homebox label's `/a/<assetId>`, `/item/<uuid>`
 * or `/location/<uuid>`, when the old Homebox hostname is pointed at Kept. It resolves the label's
 * whole URL exactly as the scanner reads one (components/scan/label-link.tsx): the phone's copy
 * first, so it opens offline, then `POST /scan/resolve`. One match opens it; an asset ID on things
 * from two collections asks which (the collection picker, scan/legacy-picker.tsx, naming each
 * thing and its location); none says "Not in your Kept"; offline and unknown, "Not on this
 * phone". Signed out, the app frame sends the person to sign in and back. It stays in the
 * precache: a label must open offline.
 */
import { useLingui } from '@lingui/react/macro';
import { useLocation } from '@tanstack/react-router';
import { useState } from 'react';
import { LabelLink } from '@/components/scan/label-link';

/** The label's URL as printed, on this host (only the path matters: D120, D146). */
export function legacyLabelUrl(pathname: string, origin = window.location.origin): string {
  return new URL(pathname, origin).href;
}

export function LegacyResolve() {
  const { t } = useLingui();
  const { pathname } = useLocation();
  // Read once: opening the thing changes the path before this page unmounts, and that path
  // isn't a label to resolve.
  const [text] = useState(() => legacyLabelUrl(pathname));
  return <LabelLink code={null} text={text} title={t`Old Homebox label`} />;
}
