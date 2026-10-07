/**
 * Connections' words, shared by the tokens list, the create sheet, the consent page and the
 * webhooks screens: what a scope lets an app do (read, or read and change, never delete: D58,
 * D124), why a token stopped working, and a list of location names.
 */
import type { TokenRevokedReason, TokenScope } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { usePrefs } from '@/lib/prefs';

export function useScopeWords() {
  const { t } = useLingui();
  return useCallback(
    (scope: TokenScope) => (scope === 'write' ? t`Read and change` : t`Read only`),
    [t],
  );
}

/** What the scope means, in a sentence: never "delete" (D58, D124). */
export function useScopeMeaning() {
  const { t } = useLingui();
  return useCallback(
    (scope: TokenScope) =>
      scope === 'write'
        ? t`Find things and add, move or change them. Never delete or see secret fields.`
        : t`Find things and read what's recorded. No changes, no secret fields.`,
    [t],
  );
}

export function useRevokedWords() {
  const { t } = useLingui();
  return useCallback(
    (reason: TokenRevokedReason | null) => {
      switch (reason) {
        case 'expired':
          return t`Expired`;
        case 'membership_ended':
          return t`Ended: you left the location`;
        case 'role_lost':
          return t`Ended: your role changed`;
        case 'admin':
          return t`Revoked by an admin`;
        case 'client_revoked':
          return t`Disconnected by the app`;
        default:
          return t`Revoked`;
      }
    },
    [t],
  );
}

/** "Home, Garage", in the reader's own list punctuation (Arabic uses its comma). */
export function useNameList() {
  const { locale } = usePrefs();
  return useCallback(
    (names: string[]) => {
      try {
        return new Intl.ListFormat(locale, { style: 'short', type: 'unit' }).format(names);
      } catch {
        return names.join(', ');
      }
    },
    [locale],
  );
}
