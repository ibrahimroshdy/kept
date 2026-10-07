/**
 * The evaluation report (plan T11; L61 "dated results"): `docs/evals/<date>-<provider>-<model>.md`.
 *
 * **Numbers and case ids only.** No extracted text, no expected values, no case notes and no
 * images: the maintainer's receipts and registration cards are personal, and the report is
 * committed. It names the model, the reasoning setting, every prompt version sent, the date, the
 * price used for cost, and the limits the run kept to.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fromMicro, toMicro } from '../src/ai/cost.js';
import { WIRE_IN_USE } from '../src/ai/wire.js';
import type { EvalRun, RunResult } from './run.js';
import {
  AUTO_ACCEPT_FIELDS,
  calibration,
  type FieldScore,
  type FieldStats,
  fieldStats,
  ratio,
  type ScoredMode,
} from './score.js';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const dec = (v: number | null, places = 2) => (v === null ? '–' : v.toFixed(places));
const frac = (a: number, b: number) => (b > 0 ? `${a}/${b}` : '–');

function sumCost(rs: RunResult[]): string {
  const sent = rs.filter((r) => r.calls.sent > 0);
  if (sent.length === 0) return '0';
  if (sent.some((r) => r.calls.cost === null)) return 'unknown';
  return fromMicro(sent.reduce((a, r) => a + toMicro(r.calls.cost as string), 0n));
}

function perRun(total: string, n: number): string {
  if (total === 'unknown' || n === 0) return total === 'unknown' ? 'unknown' : '–';
  return fromMicro(toMicro(total) / BigInt(n));
}

type Group = { mode: string; prompt: string; runs: RunResult[] };

function groups(run: EvalRun): Group[] {
  const out = new Map<string, Group>();
  for (const r of run.results) {
    const key = `${r.mode}\u0000${r.promptVersion}`;
    const g = out.get(key) ?? { mode: r.mode, prompt: r.promptVersion, runs: [] };
    g.runs.push(r);
    out.set(key, g);
  }
  return [...out.values()];
}

const sumStats = (s: FieldStats[]) =>
  s.reduce(
    (a, f) => ({
      n: a.n + f.n,
      correct: a.correct + f.correct,
      tp: a.tp + f.tp,
      fp: a.fp + f.fp,
      fn: a.fn + f.fn,
      accepted: a.accepted + f.accepted,
      falseAccepts: a.falseAccepts + f.falseAccepts,
    }),
    { n: 0, correct: 0, tp: 0, fp: 0, fn: 0, accepted: 0, falseAccepts: 0 },
  );

export function renderReport(run: EvalRun): string {
  const date = run.startedAt.toISOString().slice(0, 10);
  const L: string[] = [];
  const cur = run.price?.currency ?? 'USD';
  L.push(`# Extraction evaluation: ${run.provider.kind} \`${run.provider.model}\`, ${date}`);
  L.push('');
  L.push('Written by `pnpm eval:extraction` (apps/server/eval). Numbers and case ids only: no');
  L.push('extracted text, expected values or images.');
  L.push('');
  L.push(
    `- **Date:** ${date} (${run.startedAt.toISOString().slice(11, 16)}–${run.finishedAt.toISOString().slice(11, 16)} UTC)`,
  );
  L.push(
    `- **Provider:** ${run.provider.kind}, model \`${run.provider.model}\`, reasoning ${run.provider.reasoning ?? '–'}, temperature ${run.provider.temperature === null ? "the provider's default (callModel sends none; the worker's path)" : `**${run.provider.temperature}**, a harness experiment: the worker sends none`}`,
  );
  if (run.wire && run.wire !== WIRE_IN_USE) {
    L.push(
      `- **Wire schema:** **\`${run.wire}\`**, a harness experiment: the worker sends \`${WIRE_IN_USE}\` (ai/wire.ts)`,
    );
  }
  L.push(
    `- **Prompts:** ${Object.entries(run.promptVersions)
      .map(([m, v]) => `${m} ${v.map((x) => `\`${x}\``).join(', ')}`)
      .join(' · ')}`,
  );
  L.push(
    `- **Cases:** \`${run.set.name}\`, ${run.set.cases} case(s), ${run.results.length} run(s)${run.set.synthetic ? ', **synthetic photos** (a smoke set: it proves nothing about real photos)' : ''}`,
  );
  L.push(
    `- **Requests:** ${run.sent} sent, ${run.heldBack} held back by the pacer or the budgets; limits: at most ${run.limits.maxCalls} requests, ${run.limits.maxCostUsd === null ? 'no cost cap' : `${run.limits.maxCostUsd} USD`}, ≥ ${run.limits.gapMs / 1000} s apart${run.limits.outputTpm ? `, ≤ ${run.limits.outputTpm} output tokens a minute` : ''}${run.stopped ? `. **Stopped early: ${run.stopped}**` : ''}`,
  );
  L.push(
    `- **Price:** ${run.price ? `\`${run.price.id}\`: ${run.price.inputPerMtok} in / ${run.price.outputPerMtok} out${run.price.cachedInputPerMtok ? ` / ${run.price.cachedInputPerMtok} cached` : ''} ${run.price.currency} per million tokens` : 'none known: cost is unknown (never guessed)'}`,
  );
  L.push('');
  L.push('Scoring (apps/server/eval/score.ts): accuracy, precision and recall are on the fields');
  L.push("Kept keeps after its code checks (checks.ts); calibration is on the model's raw answer.");
  L.push('A false accept is a wrong value Kept keeps at confidence ≥ 0.6 (D19). A field the case');
  L.push('expects empty counts as right only when it stays empty.');
  L.push('');

  // Summary.
  L.push('## Summary per mode and prompt');
  L.push('');
  L.push(
    '| Mode | Prompt | Runs ok | Fields right | Precision | Recall | False accepts | Auto-accept false accepts | ECE | Brier | Length stops | Tokens in / out (reasoning) per run | Cost per run |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of groups(run)) {
    const ok = g.runs.filter((r) => r.status === 'ok');
    const sent = g.runs.filter((r) => r.calls.sent > 0);
    const n = Math.max(1, sent.length);
    const tin = Math.round(sent.reduce((a, r) => a + r.calls.inputTokens, 0) / n);
    const tout = Math.round(sent.reduce((a, r) => a + r.calls.outputTokens, 0) / n);
    const treas = Math.round(sent.reduce((a, r) => a + r.calls.reasoningTokens, 0) / n);
    const length = g.runs.filter((r) => r.reason === 'truncated').length;
    const cost = perRun(sumCost(g.runs), sent.length);
    if (g.mode === 'multi') {
      const m = ok.map((r) => r.multi).filter((x) => x !== undefined);
      const matched = m.reduce((a, x) => a + x.matched, 0);
      const exp = m.reduce((a, x) => a + x.expected, 0);
      L.push(
        `| multi (V2 probe) | \`${g.prompt}\` | ${frac(ok.length, g.runs.length)} | boxes ${frac(matched, exp)} | – | – | – | – | – | – | ${length} | ${tin} / ${tout} (${treas}) | ${cost} |`,
      );
      continue;
    }
    const stats = fieldStats(ok);
    const t = sumStats(stats);
    const auto = sumStats(
      stats.filter((s) => AUTO_ACCEPT_FIELDS[g.mode as ScoredMode].includes(s.field)),
    );
    const cal = calibration(ok.flatMap((r) => r.raw));
    L.push(
      `| ${g.mode} | \`${g.prompt}\` | ${frac(ok.length, g.runs.length)} | ${frac(t.correct, t.n)} (${pct(ratio(t.correct, t.n))}) | ${pct(ratio(t.tp, t.tp + t.fp))} | ${pct(ratio(t.tp, t.tp + t.fn))} | ${frac(t.falseAccepts, t.accepted)} | ${auto.accepted ? frac(auto.falseAccepts, auto.accepted) : '–'} | ${dec(cal.ece)} | ${dec(cal.brier)} | ${length} | ${tin} / ${tout} (${treas}) | ${cost} |`,
    );
  }
  L.push('');
  L.push(`Cost is in ${cur}, from the in-memory call ledger (callModel's own cost, D206).`);
  L.push('');

  // Fields.
  L.push('## Fields');
  for (const g of groups(run)) {
    if (g.mode === 'multi') continue;
    const ok = g.runs.filter((r) => r.status === 'ok');
    if (!ok.length) continue;
    L.push('');
    L.push(`### ${g.mode} · \`${g.prompt}\` (${ok.length} run(s))`);
    L.push('');
    L.push(
      '| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |',
    );
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const s of fieldStats(ok)) {
      L.push(
        `| ${s.field}${AUTO_ACCEPT_FIELDS[g.mode as ScoredMode].includes(s.field) ? ' (auto)' : ''} | ${s.n} | ${frac(s.correct, s.n)} | ${pct(ratio(s.tp, s.tp + s.fp))} | ${pct(ratio(s.tp, s.tp + s.fn))} | ${s.accepted} | ${s.falseAccepts} | ${s.droppedByChecks} | ${dec(s.meanConfRight)} | ${dec(s.meanConfWrong)} |`,
      );
    }
  }
  L.push('');

  // Calibration.
  L.push('## Confidence calibration (raw answers)');
  L.push('');
  L.push('| Mode | Prompt | Confidence | Values | Mean confidence | Right |');
  L.push('|---|---|---|---|---|---|');
  for (const g of groups(run)) {
    if (g.mode === 'multi') continue;
    const cal = calibration(g.runs.filter((r) => r.status === 'ok').flatMap((r) => r.raw));
    for (const b of cal.bins) {
      L.push(
        `| ${g.mode} | \`${g.prompt}\` | ${b.from.toFixed(2)}–${b.to.toFixed(2)} | ${b.n} | ${dec(b.meanConf)} | ${pct(b.accuracy)} |`,
      );
    }
  }
  L.push('');

  // Fields that must stay empty (the regressions: invented warranty terms, a model code in vin).
  const empties = run.results.flatMap((r) =>
    r.status !== 'ok'
      ? []
      : r.checked
          .map((s, i) => ({ r, s, raw: r.raw[i] as FieldScore }))
          .filter(({ s }) => !s.expectedPresent),
  );
  if (empties.length) {
    L.push('## Fields that must stay empty');
    L.push('');
    L.push('The regression checks: a field the photo does not have (warranty terms that are not');
    L.push('printed, a VIN on a TV nameplate…).');
    L.push('');
    L.push('| Case | Prompt | Run | Field | The model filled it | Kept kept it out |');
    L.push('|---|---|---|---|---|---|');
    for (const { r, s, raw } of empties) {
      L.push(
        `| ${r.caseId} | \`${r.promptVersion}\` | ${r.index} | ${s.field} | ${raw.predicted ? 'yes' : 'no'} | ${s.correct ? 'yes' : '**no**'} |`,
      );
    }
    L.push('');
  }

  // The paper outline.
  const crops = run.results.filter((r) => r.crop);
  if (crops.length) {
    L.push('## Paper outline for the receipt crop (Q11)');
    L.push('');
    L.push("What the worker's `cropToPaper` would do with the outline (it skips one that is");
    L.push('under 20% on a side or over 97% on both). `cuts_paper`: the crop would remove part of');
    L.push('the receipt (under 98% of the paper kept). `good`: kept and IoU ≥ 0.8. The last two');
    L.push("columns read the same outline as measured against the photo's longer side (score.ts");
    L.push('`fromLongSide`): a measurement of a systematic error, not what the worker does.');
    L.push('');
    L.push(
      '| Case | Prompt | Run | IoU | Paper kept | Verdict | IoU, longer side | Verdict, longer side |',
    );
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of crops) {
      const c = r.crop as NonNullable<RunResult['crop']>;
      const l = r.cropLongSide;
      const verdict = (v: string) => (v === 'cuts_paper' ? '**cuts_paper**' : v);
      L.push(
        `| ${r.caseId} | \`${r.promptVersion}\` | ${r.index} | ${dec(c.iou)} | ${pct(c.coverage)} | ${verdict(c.verdict)} | ${dec(l?.iou ?? null)} | ${l ? verdict(l.verdict) : '–'} |`,
      );
    }
    L.push('');
  }

  // Multi-item boxes.
  const multi = run.results.filter((r) => r.multi);
  if (multi.length) {
    L.push('## Multi-item boxes (V2, measured only)');
    L.push('');
    L.push(
      '| Case | Run | Objects expected | Returned | Matched (IoU ≥ 0.5) | Named right | Mean IoU | Matched, longer side | Mean IoU, longer side |',
    );
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of multi) {
      const m = r.multi as NonNullable<RunResult['multi']>;
      L.push(
        `| ${r.caseId} | ${r.index} | ${m.expected} | ${m.predicted} | ${m.matched} | ${m.named} | ${dec(m.meanIou)} | ${r.multiLongSide?.matched ?? '–'} | ${dec(r.multiLongSide?.meanIou ?? null)} |`,
      );
    }
    L.push('');
  }

  // What the checks removed.
  const removed = new Map<string, number>();
  for (const r of run.results) {
    for (const [k, v] of Object.entries(r.dropped)) {
      const key = `${r.mode}\u0000${r.promptVersion}\u0000${k}`;
      removed.set(key, (removed.get(key) ?? 0) + v);
    }
  }
  if (removed.size) {
    L.push('## What the code checks removed');
    L.push('');
    L.push('| Mode | Prompt | Field: reason | Times |');
    L.push('|---|---|---|---|');
    for (const [key, v] of [...removed.entries()].sort()) {
      const [mode, prompt, what] = key.split('\u0000');
      L.push(`| ${mode} | \`${prompt}\` | ${what} | ${v} |`);
    }
    L.push('');
  }

  // Every run.
  L.push('## Runs');
  L.push('');
  L.push(
    '| Case | Mode | Prompt | Run | Status | Fields right | Requests | In | Out | Reasoning | Cost | Latency (ms) | Finish |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of run.results) {
    const right =
      r.mode === 'multi'
        ? r.multi
          ? `boxes ${r.multi.matched}/${r.multi.expected}`
          : '–'
        : r.checked.length
          ? frac(r.checked.filter((s) => s.correct).length, r.checked.length)
          : '–';
    L.push(
      `| ${r.caseId} | ${r.mode} | \`${r.promptVersion}\` | ${r.index} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${right} | ${r.calls.sent} | ${r.calls.inputTokens} | ${r.calls.outputTokens} | ${r.calls.reasoningTokens} | ${r.calls.sent === 0 ? '–' : (r.calls.cost ?? 'unknown')} | ${r.calls.latencyMs} | ${r.calls.finishReasons.join(', ') || '–'} |`,
    );
  }
  L.push('');
  const total = sumCost(run.results);
  L.push(
    `**Total:** ${run.sent} request(s), ${total === 'unknown' ? 'cost unknown' : `${total} ${cur}`}.`,
  );
  L.push('');
  return L.join('\n');
}

/** Writes the report; a second run on the same day gets `-2`, `-3`… rather than overwriting. */
export function writeReport(run: EvalRun, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const date = run.startedAt.toISOString().slice(0, 10);
  const slug = `${date}-${run.provider.kind}-${run.provider.model}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-');
  let file = path.join(outDir, `${slug}.md`);
  for (let i = 2; existsSync(file); i++) file = path.join(outDir, `${slug}-${i}.md`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, renderReport(run));
  renameSync(tmp, file);
  return file;
}
