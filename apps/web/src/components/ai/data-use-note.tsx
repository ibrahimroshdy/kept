/**
 * "What is sent to <provider>" (D83, D206, L63; screens §5 AI settings §7): beside the provider
 * choice and on its own row. The fixed sentence first: only a copy of the photo with the location
 * and camera data removed, never the original; the fixed instructions and the location's
 * languages; for the assistant, the question and what it looks up within your role; never secret
 * fields.
 *
 * Then the provider's own retention and training terms, summarised per kind with the date they
 * were read and a link to the page they were read from (screens §8). Each summary is read from the
 * provider's own published page on its `checked` date, never paraphrased from memory, and is
 * re-read before each release (docs/release/1.0-checklist.md). A kind with no entry says where
 * its terms live instead. `openai_compatible` is a server the person runs, so it has no terms.
 */
import type { ProviderKind } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useFormat } from '@/lib/format';
import { useProviderName } from './labels';

/** Where a provider's terms were read (its own page), and on which day (`YYYY-MM-DD`). */
export type ProviderTerms = { url: string; checked: string };

/**
 * The page each summary was read from. The quotes beside each entry are the provider's own words,
 * copied from that page on the `checked` date; the summary in `useTermsSummary` says no more than
 * they do.
 */
export const PROVIDER_TERMS: Partial<Record<ProviderKind, ProviderTerms>> = {
  // "data sent to the OpenAI API is not used to train or improve OpenAI models (unless you
  // explicitly opt in to share data with us)." / "abuse monitoring logs are generated for all API
  // feature usage and retained for up to 30 days, unless longer retention is required by law".
  openai: { url: 'https://developers.openai.com/api/docs/guides/your-data', checked: '2026-10-07' },
  // "By default, we will not use your inputs or outputs from our commercial products (e.g. Claude
  // for Work, Anthropic API, Claude Gov, etc.) to train our models." Retention, from
  // https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
  // the same day: "For Anthropic API users, we automatically delete inputs and outputs on our
  // backend within 30 days of receipt or generation, except" (longer-retention features, a
  // separate agreement, enforcing the Usage Policy, the law).
  anthropic: {
    url: 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training',
    checked: '2026-10-07',
  },
  // Gemini API Additional Terms (page "Last updated 2026-04-28 UTC"). Paid: "Google doesn't use
  // your prompts (...) or responses to improve our products" and "logs prompts and responses for a
  // limited period of time, solely for detecting and preventing violations of the Prohibited Use
  // Policy". Unpaid quota: "Google uses the content you submit to the Services and any generated
  // responses to provide, improve, and develop Google products and services"; human reviewers may
  // read it.
  google: { url: 'https://ai.google.dev/gemini-api/terms', checked: '2026-10-07' },
  // "We log basic request metadata (timestamps, model used, token counts). Prompt and completion
  // are not logged by default." / "Providers that do log, or where we have been unable to confirm
  // their policy, will not be routed to unless the model training toggle is switched on in the
  // privacy settings tab."
  openrouter: { url: 'https://openrouter.ai/docs/faq', checked: '2026-10-07' },
  // "By default, Groq does not retain customer data for inference requests." / reliability and
  // abuse logs "are retained for up to 30 days, unless legally required to retain longer".
  // Training, from https://console.groq.com/docs/legal/services-agreement §4.2 (page "Last
  // Modified: June 22, 2026") the same day: "Groq is not permitted to use Inputs or Outputs for
  // training or fine-tuning any AI Model Services or other models, unless explicitly granted
  // permission or instructed by Customer."
  groq: { url: 'https://console.groq.com/docs/your-data', checked: '2026-10-07' },
};

/** Each provider's summary, in the reader's language (only for kinds in `PROVIDER_TERMS`). */
function useTermsSummary(): (kind: ProviderKind) => string | null {
  const { t } = useLingui();
  return (kind) => {
    switch (kind) {
      case 'openai':
        return t`OpenAI says data sent to its API isn't used to train its models unless you opt in, and it keeps abuse-monitoring logs for up to 30 days.`;
      case 'anthropic':
        return t`Anthropic says it doesn't use API inputs or outputs to train its models by default, and deletes them within 30 days unless its usage policy or the law needs them kept longer.`;
      case 'google':
        return t`Google says that on the Gemini API's paid tier it doesn't use your prompts or responses to improve its products, and logs them for a limited time to catch misuse. On the free tier it uses them to improve its products, and people may read them.`;
      case 'openrouter':
        return t`OpenRouter says it logs only the time, the model and token counts, not prompts or responses unless you opt in, and sends requests to providers that log or train on them only if you allow it in its privacy settings.`;
      case 'groq':
        return t`Groq says it doesn't keep inference requests by default, may keep logs for up to 30 days to fix failures or investigate abuse, and isn't permitted to train on them without your permission.`;
      case 'openai_compatible':
        return null;
    }
  };
}

export function DataUseNote({ kind, id }: { kind: ProviderKind | null; id?: string }) {
  const fmt = useFormat();
  const providerName = useProviderName();
  const termsSummary = useTermsSummary();
  const name = providerName(kind);
  const terms = kind ? PROVIDER_TERMS[kind] : undefined;
  const summary = kind && terms ? termsSummary(kind) : null;
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="grid gap-1.5">
      <h3 {...(id ? { id: `${id}-title` } : {})} className="eyebrow m-0">
        {kind ? <Trans>What is sent to {name}</Trans> : <Trans>What is sent to the provider</Trans>}
      </h3>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Only a copy of the photo with location and camera data removed, never the original. The
          fixed instructions and your location's languages. For the assistant, your question and the
          inventory it looks up, within your role. Never secret fields.
        </Trans>
      </p>
      {terms && summary ? (
        <p className="m-0 text-small text-ink-2">
          {summary}{' '}
          <a
            href={terms.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-ink underline underline-offset-2"
          >
            <Trans>
              {name}'s terms, checked {fmt.day(`${terms.checked}T12:00:00Z`)}
            </Trans>
          </a>
        </p>
      ) : kind && kind !== 'openai_compatible' ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            How {name} keeps and uses what it receives is set by its own terms for API customers.
          </Trans>
        </p>
      ) : kind === 'openai_compatible' ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>A server you run yourself keeps what you let it keep.</Trans>
        </p>
      ) : null}
    </section>
  );
}
