/**
 * The model picker (D202, D206; screens §5 AI settings, Advanced): the provider's own list, loaded
 * after a key is saved, in a Combobox (never a native select). Photos and receipts offer
 * vision-capable models only; a model whose vision the listing didn't state is offered with "Run
 * Test to check photos". The assistant gets text models, search gets embeddings models (D200).
 * RECOMMENDED's model is marked "Recommended". "Custom model id" is for OpenAI-compatible servers
 * only. A chosen model the provider stopped listing is flagged.
 */
import { RECOMMENDED } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { captureApi, captureKeys, useAiModels } from '@/api/capture/queries';
import type { AiModelListing, AiModels, AiProvider } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { RetryIcon } from '@/components/icons';
import { ErrorState, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useProviderName } from './labels';

export type ModelSlot = keyof AiModels;

type Listed = AiModelListing['models'][number];

/** The models a slot may use: vision (true or unknown) for photos, text for chat, embeddings. */
export function modelsFor(slot: ModelSlot, models: Listed[]): Listed[] {
  switch (slot) {
    case 'vision':
      return models.filter((m) => m.vision !== false && m.text);
    case 'chat':
      return models.filter((m) => m.text);
    case 'embeddings':
      return models.filter((m) => m.embeddings);
  }
}

export function ModelPickers({
  provider,
  value,
  onChange,
}: {
  provider: AiProvider;
  value: AiModels;
  onChange: (next: AiModels) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const fmt = useFormat();
  const providerName = useProviderName();
  const errorText = useErrorText();
  const q = useAiModels(provider.id);
  const [refreshing, setRefreshing] = useState(false);
  const provName = providerName(provider.kind);
  // A listing the provider refused or didn't answer is T9's 409 `ai_unavailable` (not a model call).
  const listingText = (e: unknown) =>
    isApiError(e) && e.code === 'ai_unavailable'
      ? t`Couldn't get the model list from ${provName}: it rejected the key or didn't answer. Check the key, or try again in a minute.`
      : errorText(e);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await captureApi.aiModels(provider.id, true);
      qc.setQueryData(captureKeys.ai.models(provider.id), fresh);
    } catch (e) {
      toast({ tone: 'danger', title: listingText(e) });
    } finally {
      setRefreshing(false);
    }
  };
  if (q.isError)
    return isApiError(q.error) && q.error.code === 'ai_unavailable' ? (
      <Notice
        tone="warn"
        title={<Trans>No model list</Trans>}
        action={
          <Button size="small" variant="secondary" onPress={() => void q.refetch()}>
            <Trans>Try again</Trans>
          </Button>
        }
      >
        {listingText(q.error)}
      </Notice>
    ) : (
      <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    );
  const listing = q.data;
  const models = listing?.models ?? [];
  const custom = provider.kind === 'openai_compatible';
  const slots: { slot: ModelSlot; label: string; empty: string }[] = [
    {
      slot: 'vision',
      label: t`Photos and receipts`,
      empty: t`This provider lists no model that reads photos.`,
    },
    { slot: 'chat', label: t`Assistant`, empty: t`This provider lists no chat model.` },
    {
      slot: 'embeddings',
      label: t`Search`,
      empty: t`This provider has no embeddings model: search stays keyword only.`,
    },
  ];
  return (
    <div className="grid gap-3">
      {(listing?.chosenMissing ?? []).map((slot) => {
        const model = provider.models[slot] ?? '';
        return (
          <Notice key={slot} tone="warn">
            <Trans>
              <bdi dir="ltr" className="model-id font-mono">
                {model}
              </bdi>{' '}
              is no longer offered by {provName}. Pick another.
            </Trans>
          </Notice>
        );
      })}
      {slots.map(({ slot, label, empty }) => {
        const options = modelsFor(slot, models);
        const items: ComboboxOption[] = options.map((m) => ({
          id: m.id,
          label: m.id,
          ...(m.id === RECOMMENDED.model && provider.kind === RECOMMENDED.kind
            ? { description: t`Recommended` }
            : slot === 'vision' && m.vision === null
              ? { description: t`Run Test to check photos` }
              : {}),
        }));
        const chosen = value[slot] ?? null;
        const unknownVision =
          slot === 'vision' && chosen && options.find((m) => m.id === chosen)?.vision === null;
        return (
          <div key={slot} className="grid gap-1.5">
            {options.length === 0 && !custom && listing ? (
              <p className="m-0 text-small text-ink-2">
                <span className="font-semibold text-ink">{label}: </span>
                {empty}
              </p>
            ) : (
              <Combobox
                label={label}
                items={items}
                selectedKey={chosen}
                onSelectionChange={(k) => onChange({ ...value, [slot]: k ? String(k) : undefined })}
                emptyText={empty}
                description={
                  unknownVision ? (
                    <Trans>Run Test to check photos</Trans>
                  ) : chosen === RECOMMENDED.model && provider.kind === RECOMMENDED.kind ? (
                    <Trans>Recommended</Trans>
                  ) : undefined
                }
              />
            )}
            {custom ? (
              <TextField
                label={<Trans>Custom model id ({label})</Trans>}
                value={chosen && !options.some((m) => m.id === chosen) ? chosen : ''}
                onChange={(v) => onChange({ ...value, [slot]: v.trim() || undefined })}
                inputProps={{ dir: 'ltr', spellCheck: false, autoCapitalize: 'none' }}
              />
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="small"
          variant="secondary"
          isPending={refreshing}
          onPress={() => void refresh()}
        >
          <RetryIcon aria-hidden="true" className="size-4" />
          <Trans>Refresh list</Trans>
        </Button>
        {listing?.fetchedAt ? (
          <span className="text-small text-ink-3">
            <Trans>Listed {fmt.dateTime(listing.fetchedAt)}</Trans>
          </span>
        ) : null}
      </div>
    </div>
  );
}
