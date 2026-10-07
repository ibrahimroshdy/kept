/**
 * The AI call list (L47, D205, D206; screens §5 AI usage §5): every call the scope may see, on the
 * filter strip, newest first, with the Display button's direction and "by day" grouping (D211), 20
 * a page. The instance's list has no direction switch: T9 reads it newest first only. A row says when, the task, the model, who and where, the tokens, images, ≈ cost and the
 * outcome; it opens the call's detail. Saved views live on the `ai-calls` surface. **Export CSV** downloads the filtered list: the same
 * parameters, as `text/csv` (money columns absent where the gate hides money). An installed
 * iPhone app can't download, so there the CSV is fetched and then offered on the share sheet
 * (lib/files.ts): a second press, since iOS refuses a share that waited on the network.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { captureApi, useAiCalls } from '@/api/capture/queries';
import type { AiCall, AiCallParams, AiScope } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { ChartIcon, DocumentIcon, ShareIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Pill, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { canShareFiles, downloadsWork, saveFile, shareFiles } from '@/lib/files';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { CallDetailSheet } from './call-detail';
import { aiCallParams, useAiCallFilters } from './call-filters';
import { useApproxCost, useOutcomeLabel, useTaskLabel, useTokens } from './labels';

/** Fetch the CSV with the list's filters, as a file (no new page). */
export async function fetchCallsCsv(params: AiCallParams): Promise<File> {
  const { cursor: _c, limit: _l, ...filters } = params;
  let res: Response;
  try {
    res = await fetch(captureApi.aiCallsCsvUrl(filters), {
      credentials: 'include',
      headers: { accept: 'text/csv' },
    });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.status === 429 ? 'rate_limited' : 'internal',
      res.statusText,
    );
  return new File([await res.blob()], 'ai-calls.csv', { type: 'text/csv' });
}

function CallRow({ call, onOpen }: { call: AiCall; onOpen: () => void }) {
  const fmt = useFormat();
  const task = useTaskLabel();
  const outcome = useOutcomeLabel();
  const approx = useApproxCost();
  const tokens = useTokens();
  const total = (call.tokens.input ?? 0) + (call.tokens.output ?? 0);
  const who =
    call.person === 'background' ? (
      <Trans>Kept (background)</Trans>
    ) : call.person ? (
      <bdi>{call.person.name}</bdi>
    ) : (
      <Trans>a deleted person</Trans>
    );
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="grid w-full cursor-pointer gap-1 px-3.5 py-3 text-start outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-[15px] text-ink">{task(call.task)}</span>
        <Pill tone={call.outcome === 'ok' ? 'ok' : 'warn'}>{outcome(call.outcome)}</Pill>
      </span>
      <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
        {fmt.dateTime(call.at)}
        {sep()}
        <bdi dir="ltr" className="model-id font-mono text-[12.5px]">
          {call.model}
        </bdi>
        {sep()}
        {who}
        {call.location ? (
          <>
            {sep()}
            <bdi>{call.location.name}</bdi>
          </>
        ) : null}
      </span>
      <span className="text-small text-ink-2 tabular-nums">
        {call.sent ? <Trans>{tokens(total)} tokens</Trans> : <Trans>Not sent</Trans>}
        {call.images.count > 0 ? (
          <>
            {sep()}
            <Plural value={call.images.count} one="# image" other="# images" />
          </>
        ) : null}
        {sep()}
        {call.moneyHidden ? (
          <Trans>cost hidden</Trans>
        ) : call.cost ? (
          approx(call.cost.amount, call.cost.currency)
        ) : call.sent ? (
          <Trans>cost unknown</Trans>
        ) : (
          <Trans>no cost</Trans>
        )}
        {call.attempt > 1 ? (
          <>
            {sep()}
            <Trans>attempt {fmt.num(call.attempt)}</Trans>
          </>
        ) : null}
      </span>
    </button>
  );
}

export function CallList({ scope, locationId }: { scope: AiScope; locationId?: string }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const online = useOnline();
  const errorText = useErrorText();
  const [list] = useListState();
  const params = aiCallParams(list, scope, locationId);
  const query = useAiCalls(params);
  const filters = useAiCallFilters(scope, locationId);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Fetched but not yet handed over: where downloads don't work, it waits for Share.
  const [ready, setReady] = useState<File | null>(null);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await fetchCallsCsv(params);
      if (downloadsWork()) saveFile(file);
      else setReady(file);
    } catch (e) {
      toast({ tone: 'danger', title: errorText(e) });
    } finally {
      setExporting(false);
    }
  };
  const shareCsv = async (file: File) => {
    const how = await shareFiles([file]);
    if (how === 'shared') setReady(null);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the CSV. Try again.` });
  };
  return (
    <section aria-labelledby="ai-calls" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-calls" className="eyebrow m-0">
          <Trans>Every call</Trans>
        </h2>
        <Button
          size="small"
          variant="secondary"
          isDisabled={!online}
          isPending={exporting}
          onPress={() => void exportCsv()}
          className="[&_svg]:size-4"
        >
          <DocumentIcon aria-hidden="true" />
          <Trans>Export CSV</Trans>
        </Button>
      </div>
      {ready ? (
        <Notice
          tone="ok"
          title={<Trans>Your CSV is ready</Trans>}
          action={
            <div className="flex flex-wrap gap-2">
              {canShareFiles([ready]) ? (
                <Button size="small" onPress={() => void shareCsv(ready)}>
                  <ShareIcon className="size-4" />
                  <Trans>Share</Trans>
                </Button>
              ) : null}
              <Button size="small" variant="secondary" onPress={() => setReady(null)}>
                <Trans>Close</Trans>
              </Button>
            </div>
          }
        >
          {canShareFiles([ready]) ? (
            <Trans>Share it to save it to Files or send it on.</Trans>
          ) : (
            <Trans>This browser can't save files here. Open Kept in Safari to export it.</Trans>
          )}
        </Notice>
      ) : null}
      <ListSurface<AiCall>
        label={t`AI calls`}
        search={{ label: t`Search AI calls`, placeholder: t`Model or request id` }}
        filters={filters}
        // Saved views and pinned tabs, as every list has (D205; step-3 carry-over, T28).
        surface="ai-calls"
        {...(scope === 'instance'
          ? {}
          : { sorts: [{ value: 'at', label: t`Time`, kind: 'date' as const }] })}
        groups={[
          { value: 'none', label: t`None` },
          { value: 'day', label: t`Day`, short: t`by day` },
        ]}
        groupOf={(c, by) =>
          by === 'day' ? { key: c.at.slice(0, 10), label: fmt.longDay(c.at) } : null
        }
        query={query}
        getKey={(c) => c.id}
        renderRow={(c) => <CallRow call={c} onOpen={() => setOpen(c.id)} />}
        empty={
          <EmptyState icon={<ChartIcon />} title={<Trans>No AI calls yet</Trans>}>
            <Trans>Each captured photo will appear here with what it cost.</Trans>
          </EmptyState>
        }
      />
      <CallDetailSheet callId={open} onClose={() => setOpen(null)} />
    </section>
  );
}
