/**
 * AI settings (D191, D202, D206; screens §5 "AI settings"), for one key scope:
 *
 * - `account` (Settings → AI): the account's key, for owners. Others (a member or viewer in someone
 *   else's home) get "What uses AI", a line per location saying who pays, and their own month.
 * - `me` (Settings → Me → Personal AI key): the personal key, its note (D121, D167) and its cap.
 * - `instance` (Admin → AI): the instance key, the instance caps and the editable price table.
 *
 * In order: the paused banner and key trouble at the top; "What uses AI in Kept"; where the key
 * lives; the Recommended: Groq card and "Paste your key → Test"; after the first key, "Set a
 * monthly limit?"; Using, per task; This month; Advanced (provider, models, reasoning, caps, the
 * price table, Pause AI); and what is sent to the provider. Opening it sets the
 * `ai_settings_opened` hint, which lets Essentials show AI setup items (D191).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { captureApi, captureKeys, useAiCaps, useAiProviders } from '@/api/capture/queries';
import type { AiProvider, AiScope, ProviderScope } from '@/api/capture/types';
import { api } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import { inventoryKeys, useAccounts } from '@/api/inventory/queries';
import { useLocations, useMe } from '@/api/queries';
import { ChartIcon } from '@/components/icons';
import { ErrorState, List, LoadingRows, Notice, Section } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useLocationName } from '@/lib/labels';
import { Advanced } from './advanced';
import { CapBars } from './cap-bars';
import { CapSuggest } from './cap-suggest';
import { Caps } from './caps';
import { DataUseNote } from './data-use-note';
import { KeyScope, UsingLines } from './key-scope';
import { useProviderName } from './labels';
import { PasteKey, type ProviderDraft } from './paste-key';
import { PausedBanner } from './paused-banner';
import { NoPriceNotice, Prices } from './prices';
import { RecommendedCard } from './recommended';
import { KeyTrouble, PaidByLine } from './status-line';
import { WhatUsesAi } from './what-uses-ai';

const WHAT_IS_SENT = 'ai-what-is-sent';

/** The ledger scope a provider scope reads its caps and usage in. */
const usageScope = (scope: ProviderScope): AiScope =>
  scope === 'me' ? 'me' : scope === 'instance' ? 'instance' : 'account';
const storedScope = (scope: ProviderScope): AiProvider['scope'] =>
  scope === 'me' ? 'user' : scope;

function UsageLink({ scope }: { scope: AiScope }) {
  const link =
    scope === 'instance'
      ? ({ to: '/admin/ai/usage' } as const)
      : ({ to: '/settings/ai/usage', search: { scope } } as const);
  return (
    <Link
      {...link}
      className="inline-flex items-center gap-1.5 justify-self-start font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-4"
    >
      <ChartIcon aria-hidden="true" />
      {scope === 'me' ? <Trans>My AI usage</Trans> : <Trans>AI usage</Trans>}
    </Link>
  );
}

/** Mark AI settings opened (D191), once per visit. */
function useOpenedHint() {
  const qc = useQueryClient();
  useEffect(() => {
    api
      .put<void>(inventoryPaths.hint('ai_settings_opened'), { seen: true })
      .then(() => qc.invalidateQueries({ queryKey: inventoryKeys.hints }))
      .catch(() => {
        // Only a hint: the page works without it.
      });
  }, [qc]);
}

export function AiSettings({ scope }: { scope: ProviderScope }) {
  useOpenedHint();
  const me = useMe();
  const locations = useLocations();
  const providers = useAiProviders();
  if (locations.isPending || providers.isPending || me.isPending) return <LoadingRows rows={4} />;
  if (providers.isError)
    return <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />;
  const all = locations.data ?? [];
  const owned = all.filter((l) => l.role === 'owner' && l.kind !== 'personal');
  if (scope === 'account' && owned.length === 0) return <NotAnOwner />;
  const provider =
    providers.data.providers.find((p) => p.scope === storedScope(scope) && !p.disabled) ?? null;
  return <KeySettings scope={scope} provider={provider} />;
}

/** A member or viewer: what AI does and costs, who pays where, and their own month. */
function NotAnOwner() {
  const locations = useLocations();
  const accounts = useAccounts();
  const nameOf = useLocationName();
  const shared = (locations.data ?? []).filter((l) => l.kind !== 'personal');
  const statuses = useQueries({
    queries: shared.map((l) => ({
      queryKey: captureKeys.ai.status(l.id),
      queryFn: () => captureApi.aiStatus(l.id),
    })),
  });
  const caps = useAiCaps({ scope: 'me' });
  const ownerOf = (accountId: string) =>
    accounts.data?.accounts.find((a) => a.id === accountId)?.ownerDisplayName ?? null;
  return (
    <div className="grid gap-6">
      {statuses.map((s, i) =>
        s.data?.pausedUntil ? <PausedBanner key={shared[i]?.id} status={s.data} /> : null,
      )}
      <WhatUsesAi scope="me" whatIsSentId={WHAT_IS_SENT} />
      <Section title={<Trans>Who pays for AI</Trans>}>
        <List>
          {shared.map((l, i) => {
            const s = statuses[i]?.data;
            return (
              <li key={l.id} className="px-3.5 py-3 text-[15px] text-ink">
                {s ? (
                  <PaidByLine
                    status={s}
                    owner={ownerOf(l.ownerAccountId)}
                    locationName={nameOf(l)}
                  />
                ) : (
                  <bdi>{nameOf(l)}</bdi>
                )}
              </li>
            );
          })}
        </List>
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Your own key is for Personal, your private threads, and questions that span owners.
          </Trans>{' '}
          <Link
            to="/settings/me/ai"
            className="font-semibold text-ink underline underline-offset-2"
          >
            <Trans>Personal AI key</Trans>
          </Link>
        </p>
      </Section>
      <Section title={<Trans>This month</Trans>}>
        {caps.data?.caps.length ? <CapBars caps={caps.data.caps} /> : null}
        <UsageLink scope="me" />
      </Section>
      <DataUseNote kind={null} id={WHAT_IS_SENT} />
    </div>
  );
}

function KeySettings({ scope, provider }: { scope: ProviderScope; provider: AiProvider | null }) {
  const { t } = useLingui();
  const me = useMe();
  const locations = useLocations();
  const accounts = useAccounts();
  const nameOf = useLocationName();
  const providerName = useProviderName();
  const all = locations.data ?? [];
  const owned = all.filter((l) => l.role === 'owner' && l.kind !== 'personal');
  const own = accounts.data?.accounts.find((a) => a.isOwn);
  const ownerName = own?.ownerDisplayName ?? me.data?.user.displayName ?? '';
  const aiScope = usageScope(scope);
  const caps = useAiCaps({ scope: aiScope });
  // The pause and key state, per location this key pays for.
  const watched =
    scope === 'account' ? owned : scope === 'me' ? all.filter((l) => l.kind === 'personal') : [];
  const statuses = useQueries({
    queries: watched.map((l) => ({
      queryKey: captureKeys.ai.status(l.id),
      queryFn: () => captureApi.aiStatus(l.id),
    })),
  });
  const [draft, setDraft] = useState<ProviderDraft>({ kind: null, baseUrl: '' });
  const [advanced, setAdvanced] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const paused = statuses.map((s) => s.data).filter((s) => s?.pausedUntil);
  const trouble = statuses.map((s) => s.data).find((s) => s?.waitingProvider);
  const missing = statuses.some((s) => s.data?.modelMissing);
  const capScope = scope === 'me' ? 'user' : scope;

  const section = (title: ReactNode, body: ReactNode) => <Section title={title}>{body}</Section>;
  return (
    <div className="grid gap-6">
      {paused.map((s, i) =>
        s ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: one banner per paused location, in order
          <PausedBanner key={i} status={s} />
        ) : null,
      )}
      {trouble ? (
        <KeyTrouble
          status={trouble}
          action={
            <a href="#ai-key" className="font-semibold text-ink underline underline-offset-2">
              <Trans>Replace key</Trans>
            </a>
          }
        />
      ) : null}
      {missing && provider ? (
        <Notice
          tone="warn"
          title={
            <Trans>A model you chose is no longer offered by {providerName(provider.kind)}</Trans>
          }
          action={
            <Button size="small" variant="secondary" onPress={() => setAdvanced(true)}>
              <Trans>Pick another</Trans>
            </Button>
          }
        />
      ) : null}

      <NoPriceNotice provider={provider} />

      <WhatUsesAi scope={aiScope} whatIsSentId={WHAT_IS_SENT} />

      {section(
        <Trans>Where your key lives</Trans>,
        <KeyScope scope={scope} ownerName={ownerName} homes={owned.map((l) => nameOf(l))} />,
      )}

      <section id="ai-key" aria-label={t`Your key`} className="grid gap-3">
        <h2 className="eyebrow m-0">
          {scope === 'instance' ? (
            <Trans>This server's key</Trans>
          ) : scope === 'me' ? (
            <Trans>Your personal key</Trans>
          ) : (
            <Trans>Your key</Trans>
          )}
        </h2>
        {provider ? null : <RecommendedCard />}
        <PasteKey
          scope={scope}
          provider={provider}
          draft={draft}
          onNeedsProvider={() => setAdvanced(true)}
          onSaved={(_saved, first) => {
            setDraft({ kind: null, baseUrl: '' });
            if (first && (caps.data?.caps.length ?? 0) === 0) setSuggest(true);
          }}
        />
        {provider ? null : (
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Other providers work as well: OpenAI, Anthropic, Google, OpenRouter, or your own
              OpenAI-compatible server. Paste their key, or choose one under Advanced.
            </Trans>
          </p>
        )}
        {suggest && caps.data?.suggested ? (
          <CapSuggest
            scope={capScope}
            suggested={caps.data.suggested}
            onDone={() => setSuggest(false)}
          />
        ) : null}
      </section>

      {provider
        ? section(
            <Trans>Using</Trans>,
            <UsingLines
              provider={provider}
              embeddingsSource={
                statuses.find((x) => x.data?.embeddingsSource)?.data?.embeddingsSource
              }
            />,
          )
        : null}

      {section(
        <Trans>This month</Trans>,
        <div className="grid gap-2">
          {caps.data?.caps.length ? (
            <CapBars caps={caps.data.caps} />
          ) : (
            <p className="m-0 text-small text-ink-2">
              <Trans>No monthly limit. Set one under Advanced.</Trans>
            </p>
          )}
          <UsageLink scope={aiScope} />
        </div>,
      )}

      <Advanced
        scope={scope}
        provider={provider}
        draft={draft}
        onDraftChange={setDraft}
        isExpanded={advanced}
        onExpandedChange={setAdvanced}
      >
        <Section title={<Trans>Limits</Trans>}>
          <Caps
            scope={aiScope}
            locations={owned.map((l) => ({ id: l.id, name: nameOf(l) }))}
            {...(own ? { account: { id: own.id, ownerName } } : {})}
          />
        </Section>
        {scope === 'instance' ? null : (
          <Section title={<Trans>Prices</Trans>}>
            <Prices mode="read" />
          </Section>
        )}
      </Advanced>

      {scope === 'instance' ? (
        <Section title={<Trans>Prices</Trans>}>
          <Prices mode="edit" provider={provider} />
        </Section>
      ) : null}

      <DataUseNote kind={provider?.kind ?? draft.kind} id={WHAT_IS_SENT} />
    </div>
  );
}
