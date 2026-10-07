/**
 * One AI call, in plain words (D206, screens §5 AI usage): every field the ledger recorded, the
 * other attempts of the same request, and a link to the thing it served. Opened from a row of the
 * call list and from the AI line. Nothing here was ever a prompt, a reply or an image: the ledger
 * doesn't keep them (§8a).
 *
 *   <CallDetailSheet callId={id} onClose={() => setId(null)} />
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAiCall } from '@/api/capture/queries';
import type { AiCall } from '@/api/capture/types';
import { ErrorState, LoadingRows, Pill } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { sep, useBytes, useFormat } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import {
  useApproxCost,
  useFailureReason,
  useOutcomeLabel,
  useProviderName,
  useTaskLabel,
} from './labels';

export function CallDetailSheet({
  callId,
  onClose,
}: {
  /** The ledger row to show; null keeps the sheet closed. */
  callId: string | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={callId !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t`AI call`}
      wide
    >
      {callId ? <CallDetail id={callId} /> : null}
    </Sheet>
  );
}

function CallDetail({ id }: { id: string }) {
  const q = useAiCall(id);
  if (q.isPending) return <LoadingRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const call = q.data;
  return (
    <div className="grid gap-4">
      <CallFields call={call} />
      {call.attempts.length > 0 ? <Attempts attempts={call.attempts} /> : null}
      {call.links.thingId ? (
        <Link
          to="/t/$id"
          params={{ id: call.links.thingId }}
          className="justify-self-start font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>Open the thing it read</Trans>
        </Link>
      ) : null}
    </div>
  );
}

/** "2.1 s". */
function useSeconds(): (ms: number) => string {
  const { locale, digits } = usePrefs();
  return (ms) =>
    new Intl.NumberFormat(formatLocale(locale, digits), {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(ms / 1000);
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-line border-t pt-2 first:border-t-0 first:pt-0">
      <dt className="font-semibold text-[12px] text-ink-3">{label}</dt>
      <dd className="m-0 text-[15px] text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function CallFields({ call }: { call: AiCall }) {
  const fmt = useFormat();
  const task = useTaskLabel();
  const outcome = useOutcomeLabel();
  const reason = useFailureReason();
  const provider = useProviderName();
  const approx = useApproxCost();
  const bytes = useBytes();
  const seconds = useSeconds();
  const n = (x: number | null) => fmt.num(x ?? 0);
  const payer = call.paidBy.label;
  const person =
    call.person === 'background' ? (
      <Trans>Kept (background)</Trans>
    ) : call.person ? (
      <bdi>{call.person.name}</bdi>
    ) : (
      <Trans>a deleted person</Trans>
    );
  return (
    <dl className="m-0 grid gap-2">
      <Field label={<Trans>What for</Trans>}>
        <span className="flex flex-wrap items-center gap-2">
          {task(call.task)}
          <Pill tone={call.outcome === 'ok' ? 'ok' : 'warn'}>{outcome(call.outcome)}</Pill>
        </span>
        {call.outcome !== 'ok' ? (
          <span className="block text-small text-ink-2">
            <Trans>Why: {reason(call.outcome, call.errorCode)}</Trans>
          </span>
        ) : null}
      </Field>
      <Field label={<Trans>When</Trans>}>
        {fmt.dateTime(call.at)}{' '}
        <span className="text-small text-ink-2">
          <Trans>
            · attempt {fmt.num(call.attempt)} of request{' '}
            <bdi dir="ltr" className="font-mono text-[12.5px]">
              {call.requestId}
            </bdi>
          </Trans>
        </span>
      </Field>
      <Field label={<Trans context="ai model">Model</Trans>}>
        <bdi dir="ltr" className="model-id font-mono text-[13px]">
          {call.model}
        </bdi>{' '}
        ({provider(call.providerKind)})
      </Field>
      <Field label={<Trans>Where and who</Trans>}>
        {call.location ? (
          <Trans>
            <bdi>{call.location.name}</bdi> · {person}
          </Trans>
        ) : (
          <Trans>No location · {person}</Trans>
        )}
      </Field>
      <Field label={<Trans>Paid by</Trans>}>
        {call.paidBy.scope === 'instance' ? (
          <Trans>This server's key</Trans>
        ) : call.paidBy.scope === 'account' ? (
          <Trans>
            <bdi>{payer}</bdi>'s account (the server's key would have been next)
          </Trans>
        ) : (
          <Trans>
            <bdi>{payer}</bdi>'s personal key (their account's key would have been next)
          </Trans>
        )}
        {call.paidBy.fellBack ? (
          <span className="block text-small text-ink-2">
            <Trans>No closer key was set, so it fell back to this one.</Trans>
          </span>
        ) : null}
      </Field>
      <Field label={<Trans>Tokens</Trans>}>
        {call.sent ? (
          <>
            <Trans>
              {n(call.tokens.input)} in · {n(call.tokens.output)} out
            </Trans>
            {call.tokens.reasoning ? (
              <>
                {' '}
                <Trans>({n(call.tokens.reasoning)} of them reasoning)</Trans>
              </>
            ) : null}
            {call.tokens.cached ? (
              <>
                {sep()}
                <Trans>{n(call.tokens.cached)} cached</Trans>
              </>
            ) : null}
          </>
        ) : (
          <Trans>Not sent: Kept held it back, so nothing was used.</Trans>
        )}
        {call.tokens.estimate !== null ? (
          <span className="block text-small text-ink-2">
            <Trans>Kept estimated {n(call.tokens.estimate)} before sending.</Trans>
          </span>
        ) : null}
      </Field>
      <Field label={<Trans>Images</Trans>}>
        {call.images.count === 0 ? (
          <Trans>None</Trans>
        ) : (
          <>
            <Plural value={call.images.count} one="# image" other="# images" />
            {call.images.tokensEach !== null ? (
              <>
                {sep()}
                <Trans>~{n(call.images.tokensEach)} tokens each</Trans>
              </>
            ) : null}
            {call.images.bytes !== null && call.sent ? (
              <>
                {sep()}
                <Trans>{bytes(call.images.bytes)} sent</Trans>
              </>
            ) : null}
          </>
        )}
        <span className="block text-small text-ink-2">
          <Trans>Only a copy with the location and camera data removed. Kept never keeps it.</Trans>
        </span>
      </Field>
      {call.latencyMs !== null || call.finishReason ? (
        <Field label={<Trans>How it went</Trans>}>
          {call.latencyMs !== null ? <Trans>Answered in {seconds(call.latencyMs)}</Trans> : null}
          {call.finishReason ? (
            <>
              {call.latencyMs !== null ? sep() : null}
              <Trans>
                finish reason{' '}
                <bdi dir="ltr" className="font-mono text-[12.5px]">
                  {call.finishReason}
                </bdi>
              </Trans>
            </>
          ) : null}
        </Field>
      ) : null}
      <Field label={<Trans>Cost</Trans>}>
        {call.moneyHidden ? (
          <Trans>Hidden in this location</Trans>
        ) : call.cost ? (
          <>
            {approx(call.cost.amount, call.cost.currency)}{' '}
            <span className="text-small text-ink-2">
              {call.cost.source === 'provider' ? (
                <Trans>· reported by the provider</Trans>
              ) : call.cost.source === 'price_table_later' ? (
                <Trans>· from the price table, added later</Trans>
              ) : call.cost.priceVersion !== null ? (
                <Trans>· from the price table (version {fmt.num(call.cost.priceVersion)})</Trans>
              ) : (
                <Trans>· from the price table</Trans>
              )}
            </span>
          </>
        ) : call.sent ? (
          <Trans>Cost unknown: no price for this model when it ran.</Trans>
        ) : (
          <Trans>Nothing: it wasn't sent.</Trans>
        )}
      </Field>
    </dl>
  );
}

function Attempts({ attempts }: { attempts: AiCall[] }) {
  const fmt = useFormat();
  const outcome = useOutcomeLabel();
  return (
    <section className="grid gap-1.5">
      <h3 className="eyebrow m-0">
        <Trans>Other attempts of this request</Trans>
      </h3>
      <ul className="m-0 grid list-none gap-1 p-0">
        {[...attempts]
          .sort((a, b) => a.attempt - b.attempt)
          .map((a) => (
            <li key={a.id} className="text-small text-ink-2">
              <Trans>
                Attempt {fmt.num(a.attempt)} · {fmt.dateTime(a.at)} · {outcome(a.outcome)}
              </Trans>
            </li>
          ))}
      </ul>
    </section>
  );
}
