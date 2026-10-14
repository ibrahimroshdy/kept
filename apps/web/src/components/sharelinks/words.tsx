/**
 * Share links' words (1.5, D233): what a link shares, where it stands, how long it works, and the
 * one sentence that says what a recipient sees (D116's whitelist).
 */
import type { ShareLinkScope, ShareLinkState } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';

export function useScopeWords(): Record<ShareLinkScope, string> {
  const { t } = useLingui();
  return { thing: t`Box`, place: t`Place`, view: t`List` };
}

export function useStateWords(): Record<ShareLinkState, string> {
  const { t } = useLingui();
  return { active: t`Active`, expired: t`Expired`, revoked: t`Revoked`, stopped: t`Stopped` };
}

/** The expiry choices (@kept/shared SHARE_LINK_EXPIRY_DAYS), as words. */
export function useExpiryWords(): Record<number, string> {
  const { t } = useLingui();
  return { 1: t`A day`, 7: t`A week`, 30: t`30 days`, 90: t`90 days`, 365: t`A year` };
}

/** What anyone with a link sees, and never sees (D116). */
export function WhatTheySee() {
  return (
    <Trans>
      They see names, photos, types, where things are, quantities, condition and notes. Never
      prices, serial numbers, secrets, people, loans or documents.
    </Trans>
  );
}
