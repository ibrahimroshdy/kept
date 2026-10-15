/**
 * Paperless-ngx's words (1.x, D248): why a call to Paperless failed, from the person's side.
 */
import { useLingui } from '@lingui/react/macro';
import type { PaperlessError } from '@/api/paperless/types';

export function usePaperlessErrorWords() {
  const { t } = useLingui();
  return (code: string | null | undefined): string | null => {
    if (!code) return null;
    const words: Record<PaperlessError, string> = {
      private_address: t`That address is on a private network. An instance admin can allow it in Admin → Settings.`,
      http_public: t`Use https:// for a Paperless outside your network. Over http the token would travel unencrypted.`,
      unreachable: t`Kept couldn't reach Paperless at that address.`,
      timeout: t`Paperless didn't answer within 10 seconds.`,
      redirect: t`That address answered with a redirect. Use the address it leads to.`,
      auth_failed: t`Paperless refused the token.`,
      not_paperless: t`That address doesn't answer like Paperless-ngx.`,
      too_old: t`Kept needs Paperless-ngx 2.16 or later.`,
      not_found: t`Paperless no longer has this document, or the token's user can't see it.`,
      too_large: t`That document is larger than Kept takes.`,
      failed: t`Paperless couldn't answer.`,
    };
    return words[code as PaperlessError] ?? words.failed;
  };
}

/** Whether an address is plain http (the page warns: the token travels unencrypted). */
export const isPlainHttp = (url: string) => /^\s*http:\/\//i.test(url);
