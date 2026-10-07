/**
 * "Paste your key → Test" (D191, D202, D206; screens §5 AI settings §3). One box: the provider is
 * read from the key's prefix (`detectKind`: an `sk-or-` key is OpenRouter, not OpenAI; `gsk_` is
 * Groq, which pre-selects the recommended model). A key Kept can't place opens Advanced to choose
 * the provider. Saving sends the key once and then runs Test: one real photo request and one
 * structured answer, with what the test itself cost.
 *
 * Keys are write-only: after saving, the box empties and only the hint shows ("••••abcd"), with
 * "Replace key". The first AI key anywhere needs the recovery kit (409, D193).
 */
import { detectKind, type ProviderKind } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { captureApi, captureKeys } from '@/api/capture/queries';
import type {
  AiProvider,
  AiTestResult,
  ProviderScope,
  PutAiProviderBody,
} from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { useMe } from '@/api/queries';
import { CheckCircleIcon, KeyIcon, XIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useApproxCost, useProviderName } from './labels';

/** What Advanced chose, when the key alone can't say (or the admin wants another endpoint). */
export type ProviderDraft = { kind: ProviderKind | null; baseUrl: string };

export function PasteKey({
  scope,
  provider,
  draft,
  onNeedsProvider,
  onSaved,
}: {
  scope: ProviderScope;
  provider: AiProvider | null;
  draft: ProviderDraft;
  /** Kept can't tell the provider from the key: open Advanced. */
  onNeedsProvider: () => void;
  /** After a save; `first` when this scope had no key before. */
  onSaved: (provider: AiProvider, first: boolean) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const errorText = useErrorText();
  const providerName = useProviderName();
  const me = useMe();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [kitNeeded, setKitNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detected = key.trim() ? detectKind(key) : null;
  const kind = draft.kind ?? detected;

  const test = useMutation({
    mutationFn: (id: string) => captureApi.testAiProvider(id),
    onSettled: () => qc.invalidateQueries({ queryKey: captureKeys.ai.all }),
  });
  const save = useMutation({
    mutationFn: () => {
      const body: PutAiProviderBody = { apiKey: key.trim() };
      if (draft.kind) body.kind = draft.kind;
      if (draft.kind === 'openai_compatible' && draft.baseUrl.trim())
        body.baseUrl = draft.baseUrl.trim();
      return captureApi.putAiProvider(scope, body, provider?.rowVersion);
    },
    onSuccess: async (saved) => {
      // Write-only: the key leaves the page's state the moment it's saved.
      setKey('');
      setReplacing(false);
      setError(null);
      await qc.invalidateQueries({ queryKey: captureKeys.ai.all });
      toast({ tone: 'ok', title: t`Key saved` });
      onSaved(saved, !provider);
      test.mutate(saved.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'recovery_kit_required') {
        setKitNeeded(true);
        return;
      }
      if (isApiError(e) && e.code === 'validation' && !kind) {
        setError(t`Kept can't tell which provider this key is for. Choose it under Advanced.`);
        onNeedsProvider();
        return;
      }
      if (isApiError(e) && e.code === 'private_address') {
        setError(
          t`That address is on a private network. On a self-hosted server, an instance admin can allow private addresses in Admin → Settings.`,
        );
        return;
      }
      setError(errorText(e));
    },
  });

  const showBox = !provider || replacing;
  const needsChoice = key.trim().length >= 8 && !kind;
  const submit = () => {
    if (needsChoice) {
      setError(t`Kept can't tell which provider this key is for. Choose it under Advanced.`);
      onNeedsProvider();
      return;
    }
    save.mutate();
  };

  return (
    <div className="grid gap-3">
      {kitNeeded ? (
        <Notice
          tone="warn"
          title={<Trans>Download the recovery kit first</Trans>}
          action={
            me.data?.user.instanceAdmin ? (
              <Link
                to="/admin/status"
                className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
              >
                <Trans>Open the status page</Trans>
              </Link>
            ) : undefined
          }
        >
          {me.data?.user.instanceAdmin ? (
            <Trans>
              The first AI key is a secret Kept must be able to recover. Save the recovery kit on
              the status page, then paste the key again.
            </Trans>
          ) : (
            <Trans>
              The person who runs this server needs to save the recovery kit before the first AI
              key. Ask them, then paste the key again.
            </Trans>
          )}
        </Notice>
      ) : null}

      {provider ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <KeyIcon aria-hidden="true" className="size-5 text-ink-2" />
          {/* At least 12rem for the name and hint: on a phone Test and Replace key take the row
              under them rather than squeezing "Key saved · ••••x7Qa" to three lines. */}
          <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
            <span className="font-semibold text-[15px] text-ink">
              {providerName(provider.kind)}
            </span>
            <span className="text-small text-ink-2">
              <Trans>
                Key saved ·{' '}
                <bdi dir="ltr" className="font-mono">
                  ••••{provider.keyHint ?? ''}
                </bdi>{' '}
                · never shown again
              </Trans>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              variant="secondary"
              isDisabled={!online}
              isPending={test.isPending}
              onPress={() => test.mutate(provider.id)}
            >
              <Trans>Test</Trans>
            </Button>
            {!replacing ? (
              <Button size="small" variant="ghost" onPress={() => setReplacing(true)}>
                <Trans>Replace key</Trans>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showBox ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextField
            label={provider ? <Trans>Paste the new key</Trans> : <Trans>Paste your key</Trans>}
            type="password"
            value={key}
            onChange={(v) => {
              setKey(v);
              setError(null);
            }}
            autoComplete="off"
            inputProps={{ spellCheck: false, autoCapitalize: 'none', dir: 'ltr' }}
            description={
              detected ? (
                <Trans>Looks like a {providerName(detected)} key.</Trans>
              ) : draft.kind ? (
                <Trans>For {providerName(draft.kind)}, as chosen under Advanced.</Trans>
              ) : (
                <Trans>
                  Kept reads the provider from the key. It sends the key to the server once and
                  never shows it again.
                </Trans>
              )
            }
            {...(error ? { errorMessage: error } : {})}
            isInvalid={!!error}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" isDisabled={!online || !key.trim()} isPending={save.isPending}>
              <Trans>Save and test</Trans>
            </Button>
            {replacing ? (
              <Button
                variant="ghost"
                onPress={() => {
                  setReplacing(false);
                  setKey('');
                  setError(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            ) : null}
            {!online ? (
              <span className="text-small text-ink-2">
                <Trans>Needs a connection</Trans>
              </span>
            ) : null}
          </div>
        </form>
      ) : !online ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Test needs a connection</Trans>
        </p>
      ) : null}

      {test.isError ? (
        <Notice tone="danger" title={<Trans>The test didn't run</Trans>}>
          {errorText(test.error)}
        </Notice>
      ) : test.data ? (
        <TestResultLine result={test.data} />
      ) : null}
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={
        ok ? 'inline-flex items-center gap-1 text-ok' : 'inline-flex items-center gap-1 text-danger'
      }
    >
      {ok ? (
        <CheckCircleIcon aria-hidden="true" className="size-4" />
      ) : (
        <XIcon aria-hidden="true" className="size-4" />
      )}
      <span className="text-ink">{children}</span>
    </span>
  );
}

/**
 * "✓ Photos ✓ Structured answers · Test used 2,700 tokens · ≈ USD 0.0022". The photo check's
 * `latencyMs` is 0 when no photo request was made (T9: paused, or refused before it was sent), so
 * that one reads "not sent", never "not read".
 */
export function TestResultLine({ result }: { result: AiTestResult }) {
  const fmt = useFormat();
  const approx = useApproxCost();
  const notSent = !result.vision.ok && result.vision.latencyMs === 0;
  return (
    <div role="status" className="grid gap-1 rounded-[10px] border border-line bg-surface p-3.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
        <Check ok={result.vision.ok}>
          {result.vision.ok ? (
            <Trans>Photos</Trans>
          ) : notSent ? (
            <Trans>Photos: not sent</Trans>
          ) : (
            <Trans>Photos: not read</Trans>
          )}
        </Check>
        <Check ok={result.structured.ok}>
          {result.structured.ok ? (
            <Trans>Structured answers</Trans>
          ) : (
            <Trans>Structured answers: not given</Trans>
          )}
        </Check>
      </div>
      <span className="text-small text-ink-2">
        <Trans>
          Test used {fmt.num(result.tokens)} tokens with{' '}
          <bdi dir="ltr" className="model-id font-mono">
            {result.model}
          </bdi>
        </Trans>
        {result.cost ? (
          <>
            {sep()}
            {approx(result.cost.amount, result.cost.currency)}
          </>
        ) : null}
      </span>
      {notSent ? (
        <span className="text-small text-ink-2">
          <Trans>
            The photo request wasn't sent: AI may be paused, or the provider refused the key.
          </Trans>
        </span>
      ) : !result.vision.ok && result.vision.error ? (
        <span className="text-small text-ink-2">
          <Trans>This model can't read photos here. Pick another under Advanced.</Trans>
        </span>
      ) : null}
    </div>
  );
}
