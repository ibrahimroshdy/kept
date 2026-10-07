/**
 * "Where your key lives" (D206, screens §5 AI settings §2), in words, with no location picker:
 * there are no per-location keys. And "Using" (§4): per task, the provider, the model and where
 * it comes from ("Photos and receipts: Groq · qwen/qwen3.8-27b · from your account"), or "Search:
 * keyword only (no embeddings model)".
 */
import type { EmbeddingsSource } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { AiProvider, ProviderScope } from '@/api/capture/types';
import { List } from '@/components/page';
import { sep } from '@/lib/format';
import { useProviderName } from './labels';

export function KeyScope({
  scope,
  ownerName,
  homes,
}: {
  scope: ProviderScope;
  /** The account's owner ("Ibrahim"), for "all of Ibrahim's homes". */
  ownerName: string;
  /** The account's locations other than Personal. */
  homes: string[];
}) {
  const list = homes.join(', ');
  return (
    <p className="m-0 text-[15px] text-ink">
      {scope === 'instance' ? (
        <Trans>
          This server's key pays for every location and person with no closer key. Limit what each
          account may spend below.
        </Trans>
      ) : scope === 'me' ? (
        <Trans>Used for Personal, your private threads, and questions that span owners.</Trans>
      ) : homes.length > 0 ? (
        <Trans>
          This key pays for all of <bdi>{ownerName}</bdi>'s homes: <bdi>{list}</bdi>. Your Personal
          location uses your personal key if you add one.
        </Trans>
      ) : (
        <Trans>This key pays for the homes your account owns.</Trans>
      )}
    </p>
  );
}

function UsingRow({ task, children }: { task: ReactNode; children: ReactNode }) {
  return (
    <li className="grid gap-0.5 px-3.5 py-2.5">
      <span className="font-semibold text-[14px] text-ink">{task}</span>
      <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{children}</span>
    </li>
  );
}

/**
 * "Using", per task (screens §5 AI settings §4). Search follows the server's embeddings source
 * (step 6, D207): a local model on the server, off, or the provider's embeddings model.
 */
export function UsingLines({
  provider,
  embeddingsSource,
}: {
  provider: AiProvider | null;
  embeddingsSource?: EmbeddingsSource | undefined;
}) {
  const { t } = useLingui();
  const providerName = useProviderName();
  const from =
    provider?.scope === 'instance' ? (
      <Trans>from this server</Trans>
    ) : provider?.scope === 'user' ? (
      <Trans>from you</Trans>
    ) : (
      <Trans>from your account</Trans>
    );
  const model = (id: string | undefined) =>
    provider && id ? (
      <>
        {providerName(provider.kind)}
        {sep()}
        <bdi dir="ltr" className="model-id font-mono text-[12.5px]">
          {id}
        </bdi>
        {sep()}
        {from}
      </>
    ) : null;
  return (
    <List aria-label={t`Using`}>
      <UsingRow task={<Trans>Photos and receipts</Trans>}>
        {model(provider?.models.vision) ?? <Trans>Not set: name things by hand</Trans>}
      </UsingRow>
      <UsingRow task={<Trans>Assistant</Trans>}>
        {model(provider?.models.chat) ?? <Trans>Not set</Trans>}
      </UsingRow>
      <UsingRow task={<Trans>Search</Trans>}>
        {embeddingsSource === 'local' ? (
          <Trans>A local model on this server, no per-call cost</Trans>
        ) : embeddingsSource === 'off' ? (
          <Trans>Keyword only (semantic search is off on this server)</Trans>
        ) : (
          (model(provider?.models.embeddings) ?? <Trans>Keyword only (no embeddings model)</Trans>)
        )}
      </UsingRow>
    </List>
  );
}
