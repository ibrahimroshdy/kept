/**
 * AI settings → Advanced (D191, D202; screens §5 AI settings §6): the provider kind (OpenAI,
 * Anthropic, Google, OpenRouter, Groq, OpenAI-compatible) and, for a compatible server, its base
 * URL with the private-address note; the model per task from the provider's list; the reasoning
 * effort (L42). The page adds caps, the price table and "Pause AI" below (`children`).
 *
 * A named kind's base URL is filled in by the server; only OpenAI-compatible asks for one. A key
 * whose provider Kept can't read from its prefix is saved with the kind chosen here.
 */
import {
  PROVIDER_KINDS,
  type ProviderKind,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type { AiModels, AiProvider, ProviderScope } from '@/api/capture/types';
import { useMe } from '@/api/queries';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { DataUseNote } from './data-use-note';
import { AiDisclosure } from './disclosure';
import { useProviderName } from './labels';
import { ModelPickers } from './model-picker';
import type { ProviderDraft } from './paste-key';

function useKindName(): (kind: ProviderKind) => string {
  const { t } = useLingui();
  const name = useProviderName();
  return (k) => (k === 'openai_compatible' ? t`OpenAI-compatible (Ollama, LM Studio, …)` : name(k));
}

function useReasoningLabel(): (r: ReasoningLevel) => string {
  const { t } = useLingui();
  return (r) =>
    ({
      none: t`None`,
      minimal: t`Minimal`,
      low: t`Low (the default)`,
      medium: t`Medium`,
      high: t`High`,
    })[r];
}

export function Advanced({
  scope,
  provider,
  draft,
  onDraftChange,
  isExpanded,
  onExpandedChange,
  children,
}: {
  scope: ProviderScope;
  provider: AiProvider | null;
  draft: ProviderDraft;
  onDraftChange: (draft: ProviderDraft) => void;
  isExpanded: boolean;
  onExpandedChange: (open: boolean) => void;
  /** Caps, prices and "Pause AI", per page. */
  children?: ReactNode;
}) {
  const kindName = useKindName();
  const me = useMe();
  const kind = draft.kind ?? provider?.kind ?? null;
  return (
    <AiDisclosure
      title={<Trans>Advanced</Trans>}
      isExpanded={isExpanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="grid gap-5 rounded-[10px] border border-line bg-surface p-3.5">
        <div className="grid gap-3">
          <Combobox
            label={<Trans>Provider</Trans>}
            items={PROVIDER_KINDS.map((k) => ({ id: k, label: kindName(k) }))}
            selectedKey={kind}
            onSelectionChange={(k) =>
              onDraftChange({ ...draft, kind: k ? (String(k) as ProviderKind) : null })
            }
            description={
              kind && kind !== 'openai_compatible' ? (
                <Trans>Kept fills in {kindName(kind)}'s address.</Trans>
              ) : undefined
            }
          />
          {kind === 'openai_compatible' ? (
            <TextField
              label={<Trans>Base URL</Trans>}
              value={draft.baseUrl || provider?.baseUrl || ''}
              onChange={(baseUrl) => onDraftChange({ ...draft, baseUrl })}
              type="url"
              inputProps={{ dir: 'ltr', spellCheck: false, autoCapitalize: 'none' }}
              description={
                <>
                  <Trans>
                    A server on your own network (an address like 192.168.x.x) needs private
                    addresses allowed on this server.
                  </Trans>{' '}
                  {me.data?.user.instanceAdmin ? (
                    <Link
                      to="/admin/settings"
                      className="font-semibold text-ink underline underline-offset-2"
                    >
                      <Trans>Admin settings</Trans>
                    </Link>
                  ) : (
                    <Trans>Ask an instance admin.</Trans>
                  )}
                </>
              }
            />
          ) : null}
          <DataUseNote kind={kind} />
        </div>
        {provider ? (
          <ModelsForm key={provider.id} scope={scope} provider={provider} />
        ) : (
          <p className="m-0 text-small text-ink-2">
            <Trans>Save a key first: Kept then loads the provider's models to choose from.</Trans>
          </p>
        )}
        {children}
      </div>
    </AiDisclosure>
  );
}

function ModelsForm({ scope, provider }: { scope: ProviderScope; provider: AiProvider }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const errorText = useErrorText();
  const reasoningLabel = useReasoningLabel();
  const [models, setModels] = useState<AiModels>(provider.models);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(provider.reasoning);
  useEffect(() => {
    setModels(provider.models);
    setReasoning(provider.reasoning);
  }, [provider]);
  const changed =
    reasoning !== provider.reasoning ||
    (['vision', 'chat', 'embeddings'] as const).some((s) => models[s] !== provider.models[s]);
  const save = useMutation({
    mutationFn: () => captureApi.putAiProvider(scope, { models, reasoning }, provider.rowVersion),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Models saved` });
    },
    onError: (e) => toast({ tone: 'danger', title: errorText(e) }),
  });
  return (
    <div className="grid gap-3">
      <h3 className="eyebrow m-0">
        <Trans>Models</Trans>
      </h3>
      <ModelPickers provider={provider} value={models} onChange={setModels} />
      <Select<{ id: ReasoningLevel }>
        label={<Trans>Reasoning effort</Trans>}
        items={REASONING_LEVELS.map((id) => ({ id }))}
        value={reasoning}
        onChange={(k) => {
          if (k != null) setReasoning(k as ReasoningLevel);
        }}
        description={
          <Trans>More reasoning can read harder photos, and costs more output tokens.</Trans>
        }
      >
        {(item) => (
          <SelectItem id={item.id} textValue={reasoningLabel(item.id)}>
            {reasoningLabel(item.id)}
          </SelectItem>
        )}
      </Select>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          isDisabled={!changed || !online}
          isPending={save.isPending}
          onPress={() => save.mutate()}
        >
          <Trans>Save models</Trans>
        </Button>
        {!online ? (
          <span className="text-small text-ink-2">
            <Trans>Needs a connection</Trans>
          </span>
        ) : null}
      </div>
    </div>
  );
}
