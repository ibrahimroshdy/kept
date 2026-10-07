/**
 * Words for expiring documents (plan T23; D155, D172, Q31): each kind's name, and a document's
 * name as a reader sees it, its own title when it has one, otherwise its kind ("Insurance").
 */
import type { DocumentKind } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { DocumentState } from '@/api/household/types';
import type { PillTone } from '@/components/page';

export function useDocumentKindLabels(): Record<DocumentKind, string> {
  const { t } = useLingui();
  return {
    registration: t`Registration`,
    insurance: t`Insurance`,
    licence: t`Licence`,
    inspection: t`Inspection`,
    lease: t`Lease`,
    contract: t`Contract`,
    other: t`Other`,
  };
}

/** A document's name: its title, or its kind's (Q31: "other" always has a title). */
export function useDocumentName(): (d: { kind: DocumentKind; title: string | null }) => string {
  const kinds = useDocumentKindLabels();
  return (d) => d.title?.trim() || kinds[d.kind];
}

/** Where a document's term stands, as a pill's tone. */
export const DOCUMENT_TONE: Record<DocumentState, PillTone> = {
  ok: 'neutral',
  expiring: 'warn',
  expired: 'danger',
};

/** A `YYYY-MM-DD` day as the instant `useFormat().day` reads: its noon, so no zone moves it. */
export const noonOf = (day: string) => `${day}T12:00:00`;
