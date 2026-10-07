/**
 * Admin → Status → Embeddings (step-6 plan T24; D200, D206, D207): where semantic search's
 * vectors come from (each location's AI provider, a local model on this server, or off), how much
 * is indexed ("Indexed 8,412 of 10,000 things"), a cap pause, and the switch. `local` is offered
 * only when the server says its package is there, with the model's download size and "runs on
 * this server; no key; no per-call cost"; while the first download runs, its progress shows.
 * Switching is audited by the server; with `off` (or nothing indexed) search stays on keywords.
 */
import type { EmbeddingsSource } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ProgressBar } from 'react-aria-components';
import { putEmbeddingsSource } from '@/api/admin';
import { keys } from '@/api/queries';
import type { AdminStatus, EmbeddingsStatus } from '@/api/types';
import { usePausedUntil } from '@/components/ai/paused-banner';
import { Notice, Section, useErrorText } from '@/components/page';
import { useConfirm } from '@/components/ui/confirm';
import { Segmented } from '@/components/ui/segmented';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

/** "137 MB" in the reader's digits. */
function useMegabytes() {
  const f = useFormat();
  const { t } = useLingui();
  return (bytes: number) => {
    const mb = f.num(Math.max(1, Math.round(bytes / 1_000_000)));
    return t`${mb} MB`;
  };
}

export function EmbeddingsSourceSection({ embeddings: e }: { embeddings: EmbeddingsStatus }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const online = useOnline();
  const errorText = useErrorText();
  const mb = useMegabytes();
  const pausedUntil = usePausedUntil();
  const indexed = f.num(e.indexed);
  const total = f.num(e.total);
  const size = e.local.downloadBytes !== null ? mb(e.local.downloadBytes) : null;

  const save = useMutation({
    mutationFn: (source: EmbeddingsSource) => putEmbeddingsSource({ source }),
    onSuccess: (next) => {
      qc.setQueryData<AdminStatus>(keys.admin.status, (s) => (s ? { ...s, embeddings: next } : s));
      toast({ title: t`Search embeddings updated`, tone: 'ok' });
    },
    onError: (err) => toast({ title: errorText(err), tone: 'danger' }),
  });

  const choose = async (source: EmbeddingsSource) => {
    if (source === e.source) return;
    if (source === 'local') {
      const ok = await confirm({
        title: t`Use a local model for search?`,
        body: size
          ? t`Kept downloads the model once (${size}) and runs it on this server: no key, no per-call cost. Everything is indexed again with it.`
          : t`Kept runs the model on this server: no key, no per-call cost. Everything is indexed again with it.`,
        confirmLabel: t`Use the local model`,
      });
      if (!ok) return;
    }
    if (source === 'off') {
      const ok = await confirm({
        title: t`Turn semantic search off?`,
        body: t`Search finds things by their words only. Nothing more is sent for indexing.`,
        confirmLabel: t`Turn off`,
      });
      if (!ok) return;
    }
    save.mutate(source);
  };

  const downloading = e.source === 'local' && e.local.downloadedBytes !== null;
  const got = mb(e.local.downloadedBytes ?? 0);
  return (
    <Section title={<Trans>Search embeddings</Trans>}>
      {e.paused ? (
        <Notice tone="warn" title={pausedUntil(e.paused.until)}>
          <Trans>Search finds things by their words until then. Indexing carries on after.</Trans>
        </Notice>
      ) : null}
      <div className="grid gap-4 rounded-[10px] border border-line bg-surface p-3.5">
        <Segmented<EmbeddingsSource>
          label={t`Where meaning comes from`}
          value={e.source}
          onChange={(s) => void choose(s)}
          isDisabled={!online || save.isPending}
          options={[
            { id: 'provider', label: t`Each location's AI` },
            { id: 'local', label: t`This server`, isDisabled: !e.local.available },
            { id: 'off', label: t`Off` },
          ]}
          description={
            e.source === 'provider' ? (
              <Trans>
                Each location's AI provider indexes its things and each search, and that location
                pays. A location whose provider has no embeddings model searches by words only.
              </Trans>
            ) : e.source === 'local' ? (
              <Trans>Runs on this server; no key; no per-call cost.</Trans>
            ) : (
              <Trans>Search finds things by their words only.</Trans>
            )
          }
        />
        {!e.local.available ? (
          <p className="m-0 text-small text-ink-3">
            <Trans>The local model isn't installed on this server, so it can't be chosen.</Trans>
          </p>
        ) : e.source !== 'local' && size ? (
          <p className="m-0 text-small text-ink-3">
            <Trans>
              This server: a {size} download, once. Runs here; no key; no per-call cost.
            </Trans>
          </p>
        ) : null}
        {downloading && e.local.downloadBytes ? (
          <ProgressBar
            aria-label={t`Downloading the local model`}
            value={e.local.downloadedBytes ?? 0}
            maxValue={e.local.downloadBytes}
            valueLabel={t`${got} of ${size}`}
            className="grid gap-1.5"
          >
            {({ percentage, valueText }) => (
              <>
                <span className="flex flex-wrap items-baseline justify-between gap-2 text-small">
                  <span className="text-ink">
                    <Trans>Downloading the local model</Trans>
                  </span>
                  <span className="text-ink-2">{valueText}</span>
                </span>
                <Bar percentage={percentage ?? 0} />
              </>
            )}
          </ProgressBar>
        ) : null}
        {e.source !== 'off' ? (
          <ProgressBar
            aria-label={t`Things indexed for search`}
            value={e.indexed}
            maxValue={Math.max(e.total, 1)}
            valueLabel={t`Indexed ${indexed} of ${total} things`}
            className="grid gap-1.5"
          >
            {({ percentage, valueText }) => (
              <>
                <span className="text-small text-ink-2">{valueText}</span>
                <Bar percentage={percentage ?? 0} />
              </>
            )}
          </ProgressBar>
        ) : null}
      </div>
      {!online ? (
        <p className="m-0 text-ink-2 text-small">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
    </Section>
  );
}

function Bar({ percentage }: { percentage: number }) {
  return (
    <span className="h-2 overflow-hidden rounded-full bg-sunken">
      <span
        className="block h-full bg-ink transition-[width]"
        style={{ width: `${percentage}%` }}
      />
    </span>
  );
}
