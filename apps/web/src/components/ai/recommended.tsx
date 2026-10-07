/**
 * "Recommended: Groq" (D206, screens §5 AI settings), above the key box while no key is saved:
 * why Groq with qwen/qwen3.8-27b, in the measured figures and their date, said plainly (a synthetic
 * test the evaluation re-checks; Groq has no embeddings model; about 2–3 photos a minute, paced),
 * with a link to Groq's key page. The other providers stay equal choices below it.
 */
import { RECOMMENDED, REFERENCE_FIGURES } from '@kept/shared';
import { Trans } from '@lingui/react/macro';
import { StarIcon } from '@/components/icons';
import { useFormat } from '@/lib/format';
import { AiDisclosure } from './disclosure';
import { useApproxCost } from './labels';

/**
 * Groq's page for creating an API key, from Groq's own quickstart ("Please visit here to create
 * an API Key", linking /keys on console.groq.com), read on 2026-09-29. One constant, so a change
 * on Groq's side is one edit.
 */
export const GROQ_KEYS_URL = 'https://console.groq.com/keys';

/** The measured figures (REFERENCE_FIGURES), as "Why?" lists them. */
export function WhyGroq() {
  const fmt = useFormat();
  const approx = useApproxCost();
  const f = REFERENCE_FIGURES.tasks;
  const date = fmt.day(`${REFERENCE_FIGURES.asOf}T12:00:00Z`);
  const tokens = (x: { inputTokens: number; outputTokens: number }) =>
    fmt.num(x.inputTokens + x.outputTokens);
  // The pace's figures follow the reader's digits (D143), like every other number here.
  const low = fmt.num(2);
  const high = fmt.num(3);
  const photos = fmt.num(30);
  const fromMin = fmt.num(10);
  const toMin = fmt.num(15);
  return (
    <div className="grid gap-2 text-small text-ink-2">
      <p className="m-0">
        <Trans>
          In Kept's test on {date}, it read receipts, labels and nameplates correctly for the least
          money of any model measured:
        </Trans>
      </p>
      <ul className="m-0 grid gap-1 ps-5">
        <li>
          <Trans>
            A receipt: {tokens(f.extract_receipt)} tokens ·{' '}
            {approx(f.extract_receipt.cost, REFERENCE_FIGURES.currency)}
          </Trans>
        </li>
        <li>
          <Trans>
            A nameplate: {tokens(f.extract_label)} tokens ·{' '}
            {approx(f.extract_label.cost, REFERENCE_FIGURES.currency)}
          </Trans>
        </li>
        <li>
          <Trans>
            An odometer: {tokens(f.extract_reading)} tokens ·{' '}
            {approx(f.extract_reading.cost, REFERENCE_FIGURES.currency)}
          </Trans>
        </li>
      </ul>
      <p className="m-0">
        <Trans>
          That was a test with made-up photos; Kept's evaluation with real photos checks it again.
          Groq has no embeddings model, so semantic search needs another provider or stays keyword
          only. On the key tier Kept measured, Groq reads {low}–{high} photos a minute; Kept paces
          to it, so a {photos}-photo session is named over {fromMin}–{toMin} minutes while you carry
          on.
        </Trans>
      </p>
    </div>
  );
}

export function RecommendedCard() {
  const fmt = useFormat();
  // Figures in the reader's digits (D143): "٠٫٠٠٤", not a Western "0.004" inside Arabic.
  const perReceipt = fmt.num(0.004);
  const low = fmt.num(2);
  const high = fmt.num(3);
  return (
    <section
      aria-labelledby="ai-recommended"
      className="grid gap-2 rounded-[10px] border-2 border-ink bg-surface p-3.5"
    >
      <h3 id="ai-recommended" className="m-0 flex items-center gap-2 font-semibold text-[16px]">
        <StarIcon aria-hidden="true" className="size-4" />
        <Trans>Recommended: Groq</Trans>
      </h3>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          The cheapest reliable result in Kept's test: about USD {perReceipt} a receipt, with{' '}
          <bdi dir="ltr" className="model-id font-mono text-[12.5px]">
            {RECOMMENDED.model}
          </bdi>
          . On the key tier Kept measured, Groq reads {low}–{high} photos a minute; Kept paces to
          it.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a
          href={GROQ_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>Get a Groq key</Trans>
        </a>
        <AiDisclosure quiet title={<Trans>Why?</Trans>}>
          <WhyGroq />
        </AiDisclosure>
      </div>
    </section>
  );
}
