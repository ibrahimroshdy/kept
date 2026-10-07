/**
 * The AI screens' words (D206, product design §8a): ledger tasks, outcomes and error codes in
 * plain language, and money as the ledger shows it. One place, so the usage page, the call list,
 * the call's detail, the AI line and "What uses AI" say the same thing the same way.
 */
import type { LedgerOutcome, LedgerTask, ProviderKind } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { AiCallSummary, PayerScope } from '@/api/capture/types';
import { formatLocale, usePrefs } from '@/lib/prefs';

/** What a call was for (`llm_calls.task`), as the usage page names it. */
export function useTaskLabel(): (task: LedgerTask) => string {
  const { t } = useLingui();
  return (task) => {
    switch (task) {
      case 'extract_thing':
        return t`Photo`;
      case 'extract_receipt':
        return t`Receipt`;
      case 'extract_label':
        return t`Label or nameplate`;
      case 'extract_reading':
        return t`Meter reading`;
      case 'assistant_turn':
        return t`Assistant question`;
      case 'assistant_followup':
        return t`Assistant follow-up`;
      case 'embed_thing':
        return t`Search index`;
      case 'embed_query':
        return t`Semantic search`;
      case 'connection_test':
        return t`Test connection`;
      case 'enrich_aliases':
        return t`Aliases for imported things`;
    }
  };
}

/** "What uses AI in Kept"'s action names (screens §5): per action, not per call. */
export function useActionLabel(): (task: LedgerTask) => string {
  const { t } = useLingui();
  const task = useTaskLabel();
  return (x) => {
    switch (x) {
      case 'extract_thing':
        return t`Each captured photo`;
      case 'extract_receipt':
        return t`Each receipt (up to 4 pages in one call)`;
      case 'extract_label':
        return t`Each label or nameplate photo`;
      case 'extract_reading':
        return t`Each meter reading`;
      case 'assistant_turn':
        return t`Each assistant question`;
      case 'embed_query':
      case 'embed_thing':
        return t`Semantic search`;
      case 'connection_test':
        return t`"Test connection"`;
      default:
        return task(x);
    }
  };
}

/** `llm_calls.outcome` in words (screens §5 AI usage). */
export function useOutcomeLabel(): (outcome: LedgerOutcome) => string {
  const { t } = useLingui();
  return (o) => {
    switch (o) {
      case 'ok':
        return t`OK`;
      case 'refused':
        return t`Refused`;
      case 'rate_limited':
        return t`Rate-limited`;
      case 'over_budget':
        return t`Over budget`;
      case 'provider_error':
        return t`Provider error`;
      case 'timeout':
        return t`Timed out`;
      case 'schema_invalid':
        return t`Invalid answer`;
      case 'truncated':
        return t`Cut off`;
    }
  };
}

/**
 * Why a call failed, from its `error_code` (the server's ai/errors.ts and the held-back reasons):
 * "the provider timed out". Falls back to the outcome when the code is unknown or absent.
 */
export function useFailureReason(): (outcome: LedgerOutcome, code?: string | null) => string {
  const { t } = useLingui();
  return (outcome, code) => {
    switch (code) {
      case 'timeout':
        return t`the provider timed out`;
      case 'auth':
        return t`the provider rejected the key`;
      case 'quota':
        return t`the provider's quota is used up`;
      case 'http_429':
        return t`the provider asked Kept to slow down`;
      case 'http_5xx':
      case 'error_in_200':
        return t`the provider had an error`;
      case 'http_4xx':
        return t`the provider refused the request`;
      case 'network':
        return t`the provider couldn't be reached`;
      case 'content_filter':
        return t`the provider's content filter declined it`;
      case 'length':
        return t`the answer was cut off`;
      case 'invalid_json':
      case 'schema':
        return t`the answer wasn't in the shape Kept asked for`;
      case 'cap_money':
        return t`the monthly cap was reached`;
      case 'cap_tokens':
        return t`the monthly token limit was reached`;
      case 'tokens_day':
        return t`today's AI budget was used up`;
      case 'manual':
        return t`AI was paused by hand`;
      default:
        break;
    }
    switch (outcome) {
      case 'refused':
        return t`the provider declined it`;
      case 'rate_limited':
        return t`the provider's rate limit was reached`;
      case 'over_budget':
        return t`a cap or budget was reached`;
      case 'timeout':
        return t`the provider timed out`;
      case 'schema_invalid':
        return t`the answer wasn't in the shape Kept asked for`;
      case 'truncated':
        return t`the answer was cut off`;
      default:
        return t`the provider had an error`;
    }
  };
}

/** Where a key lives, as a payer: "instance", "account", "your own key". */
export function usePayerScopeLabel(): (scope: PayerScope) => string {
  const { t } = useLingui();
  return (scope) =>
    scope === 'instance'
      ? t`this server's key`
      : scope === 'account'
        ? t`the account's key`
        : t`a personal key`;
}

/** "USD 5.00": money as caps and totals show it, in the reader's digits. */
export function useMoney(): (amount: string | number, currency: string) => string {
  const { locale, digits } = usePrefs();
  return (amount, currency) => {
    const nf = new Intl.NumberFormat(formatLocale(locale, digits), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${currency} ${nf.format(Number(amount))}`;
  };
}

/** Compact token counts: "2.5k", "1.6M", in the reader's digits. */
export function useTokens(): (n: number) => string {
  const { locale, digits } = usePrefs();
  return (n) =>
    new Intl.NumberFormat(formatLocale(locale, digits), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
}

/** A read that didn't produce an answer (the AI line says why instead of "Read by"). */
export const failedRead = (call: Pick<AiCallSummary, 'outcome'>) => call.outcome !== 'ok';

/** A provider's name as its maker writes it; a custom endpoint is described. */
export function useProviderName(): (kind: ProviderKind | null) => string {
  const { t } = useLingui();
  return (kind) => {
    switch (kind) {
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      case 'google':
        return 'Google';
      case 'openrouter':
        return 'OpenRouter';
      case 'groq':
        return 'Groq';
      default:
        return t`your AI provider`;
    }
  };
}

/** "≈ USD 0.0039": four decimals below 0.01, two above; the reader's digits. */
export function useApproxCost(): (amount: string, currency: string) => string {
  const { locale, digits } = usePrefs();
  return (amount, currency) => {
    const n = Number(amount);
    const small = Math.abs(n) > 0 && Math.abs(n) < 0.01;
    const nf = new Intl.NumberFormat(formatLocale(locale, digits), {
      minimumFractionDigits: small ? 4 : 2,
      maximumFractionDigits: small ? 4 : 2,
    });
    // No-break spaces: "≈ USD 0.0030" never splits, leaving "≈" at a line's end (the phone pass).
    return `≈\u00a0${currency}\u00a0${nf.format(n)}`;
  };
}
