/**
 * The inbox's words: kinds (the chips and each item's pill), suggested fields, why an extraction
 * failed, and why a sync op was dropped. Screens §5 "Inbox", engineering spec §5.
 */
import { aliasSuggestionLanguage, type DropReason, type InboxKind } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { usePrefs } from '@/lib/prefs';

/** The chips, in the order the design board lists them (D191: a zero-count chip is hidden). */
export const KIND_ORDER: readonly InboxKind[] = [
  'draft',
  'receipt',
  'reading',
  'currency',
  'duplicate',
  'label_claim',
  'sync_drop',
];

export function useKindLabels(): Record<InboxKind, { chip: string; pill: string }> {
  const { t } = useLingui();
  return {
    draft: { chip: t`Drafts`, pill: t`Draft` },
    receipt: { chip: t`Receipts`, pill: t`Receipt` },
    reading: { chip: t`Readings`, pill: t`Reading doesn't fit` },
    currency: { chip: t`Currency`, pill: t`Needs a currency` },
    duplicate: { chip: t`Duplicates`, pill: t`Likely duplicate` },
    label_claim: { chip: t`Label claims`, pill: t`Label already claimed` },
    sync_drop: { chip: t`Couldn't sync`, pill: t`Couldn't sync` },
  };
}

/** A suggested field's name ("Suggested · price"). Unknown fields show their key. An alias
 * (`alias_ar`, D214) names its language in the reader's own. */
export function useFieldLabels(): (field: string) => string {
  const { t } = useLingui();
  const { locale } = usePrefs();
  const names: Record<string, string> = {
    name: t`name`,
    brand: t`brand`,
    model: t`model`,
    type: t`type`,
    colour: t`colour`,
    serial: t`serial number`,
    quantity: t`quantity`,
    expires_on: t`expiry date`,
    manufactured_on: t`manufacture date`,
    vin: t`VIN`,
    plate: t`number plate`,
    price: t`price`,
    purchased_on: t`purchase date`,
    warranty: t`warranty end`,
    reading: t`reading`,
    vendor: t`shop`,
    currency: t`currency`,
    document: t`vehicle document`,
  };
  return (field) => {
    const lang = aliasSuggestionLanguage(field);
    if (lang) {
      const language = languageName(lang, locale);
      return t`search word (${language})`;
    }
    return names[field] ?? field;
  };
}

/** A language's name in `locale` ("Arabic", "arabe"), or its code where the browser has none. */
function languageName(lang: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/** Why the provider couldn't read a photo, in words (`extractions.status_reason`, §7.15). */
export function useFailureText(): (reason: string | undefined) => string {
  const { t } = useLingui();
  return (reason) => {
    switch (reason) {
      case 'timeout':
        return t`Couldn't read this photo (the provider took too long)`;
      case 'refused':
        return t`Couldn't read this photo (the provider refused it)`;
      case 'schema_invalid':
        return t`Couldn't read this photo (the answer made no sense)`;
      case 'truncated':
      case 'length':
        return t`Couldn't read this photo (the answer was cut off)`;
      default:
        return t`Couldn't read this photo (provider error)`;
    }
  };
}

/** Why a change made offline didn't apply (D35). */
export function useDropReasonText(): (reason: DropReason | string) => string {
  const { t } = useLingui();
  return (reason) => {
    switch (reason) {
      case 'target_trashed':
        return t`Where it was going was trashed in the meantime.`;
      case 'target_missing':
        return t`What it changed no longer exists.`;
      case 'not_permitted':
        return t`You can no longer change things there.`;
      case 'parent_dropped':
        return t`It depended on another change that couldn't apply.`;
      case 'location_revoked':
        return t`You were removed from that location.`;
      default:
        return t`The server couldn't apply it.`;
    }
  };
}
