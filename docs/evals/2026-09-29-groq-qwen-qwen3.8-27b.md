# Extraction evaluation: groq `qwen/qwen3.8-27b`, 2026-09-29

Written by `pnpm eval:extraction` (apps/server/eval). Numbers and case ids only: no
extracted text, expected values or images.

- **Date:** 2026-09-29 (05:37–05:51 UTC)
- **Provider:** groq, model `qwen/qwen3.8-27b`, reasoning low, temperature the provider's default (callModel sends none; the worker's path)
- **Prompts:** receipt `receipt-v1`, `receipt-v2` · label `label-v1` · reading `reading-v1` · thing `thing-v1` · multi `multi-probe-v1`
- **Cases:** `synthetic-2026-09-29`, 9 case(s), 12 run(s), **synthetic photos** (a smoke set: it proves nothing about real photos)
- **Requests:** 12 sent, 1 held back by the pacer or the budgets; limits: at most 12 requests, 0.5 USD, ≥ 65 s apart, ≤ 1000 output tokens a minute. **Stopped early: budget_calls**
- **Price:** `groq-listing-2026-09-26`: 0.8 in / 4 out / 0.4 cached USD per million tokens

Scoring (apps/server/eval/score.ts): accuracy, precision and recall are on the fields
Kept keeps after its code checks (checks.ts); calibration is on the model's raw answer.
A false accept is a wrong value Kept keeps at confidence ≥ 0.6 (D19). A field the case
expects empty counts as right only when it stays empty.

## Summary per mode and prompt

| Mode | Prompt | Runs ok | Fields right | Precision | Recall | False accepts | Auto-accept false accepts | ECE | Brier | Length stops | Tokens in / out (reasoning) per run | Cost per run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt | `receipt-v1` | 3/3 | 13/18 (72%) | 86% | 75% | 2/14 | – | 0.10 | 0.12 | 0 | 2218 / 734 (399) | 0.00471 |
| receipt | `receipt-v2` | 3/3 | 12/18 (67%) | 92% | 69% | 1/12 | – | 0.09 | 0.06 | 0 | 2221 / 908 (577) | unknown |
| label | `label-v1` | 2/2 | 6/12 (50%) | 100% | 33% | 0/3 | 0/2 | 0.22 | 0.20 | 0 | 2189 / 774 (716) | 0.004845 |
| reading | `reading-v1` | 0/1 | – (–) | – | – | – | – | – | – | 0 | 0 / 0 (0) | unknown |
| thing | `thing-v1` | 0/2 | – (–) | – | – | – | – | – | – | 0 | 0 / 0 (0) | unknown |
| multi (V2 probe) | `multi-probe-v1` | 0/1 | boxes – | – | – | – | – | – | – | 0 | 0 / 0 (0) | – |

Cost is in USD, from the in-memory call ledger (callModel's own cost, D206).

## Fields

### receipt · `receipt-v1` (3 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| vendor | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| date | 3 | 2/3 | 100% | 67% | 2 | 0 | 0 | 0.95 | – |
| currency | 3 | 1/3 | 100% | 33% | 1 | 0 | 0 | 0.98 | – |
| total | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| lines | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| warranty_terms_printed | 3 | 1/3 | 0% | 0% | 2 | 2 | 0 | – | 0.93 |

### receipt · `receipt-v2` (3 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| vendor | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| date | 3 | 1/3 | 100% | 33% | 1 | 0 | 0 | 0.97 | – |
| currency | 3 | 0/3 | – | 0% | 0 | 0 | 0 | – | – |
| total | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| lines | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| warranty_terms_printed | 3 | 2/3 | 50% | 100% | 2 | 1 | 1 | 0.90 | 0.45 |

### label · `label-v1` (2 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| brand (auto) | 2 | 1/2 | 100% | 50% | 1 | 0 | 0 | 0.99 | – |
| model (auto) | 2 | 1/2 | 100% | 50% | 1 | 0 | 0 | 0.97 | – |
| serial | 1 | 1/1 | 100% | 100% | 1 | 0 | 0 | 0.93 | – |
| vin | 2 | 1/2 | – | 0% | 0 | 0 | 1 | – | 0.90 |
| plate | 2 | 1/2 | – | 0% | 0 | 0 | 0 | – | – |
| document_kind | 2 | 1/2 | – | 0% | 0 | 0 | 0 | – | – |
| expires_on | 1 | 0/1 | – | 0% | 0 | 0 | 0 | – | – |

## Confidence calibration (raw answers)

| Mode | Prompt | Confidence | Values | Mean confidence | Right |
|---|---|---|---|---|---|
| receipt | `receipt-v1` | 0.90–0.95 | 1 | 0.90 | 0% |
| receipt | `receipt-v1` | 0.95–1.00 | 13 | 0.96 | 92% |
| receipt | `receipt-v2` | 0.00–0.60 | 1 | 0.00 | 0% |
| receipt | `receipt-v2` | 0.90–0.95 | 2 | 0.90 | 50% |
| receipt | `receipt-v2` | 0.95–1.00 | 10 | 0.97 | 100% |
| label | `label-v1` | 0.90–0.95 | 2 | 0.92 | 50% |
| label | `label-v1` | 0.95–1.00 | 2 | 0.98 | 100% |

## Fields that must stay empty

The regression checks: a field the photo does not have (warranty terms that are not
printed, a VIN on a TV nameplate…).

| Case | Prompt | Run | Field | The model filled it | Kept kept it out |
|---|---|---|---|---|---|
| receipt-en | `receipt-v1` | 1 | warranty_terms_printed | yes | **no** |
| receipt-en | `receipt-v2` | 1 | warranty_terms_printed | yes | **no** |
| receipt-ar | `receipt-v1` | 1 | warranty_terms_printed | no | yes |
| receipt-ar | `receipt-v2` | 1 | warranty_terms_printed | yes | yes |
| label-nameplate | `label-v1` | 1 | vin | yes | yes |
| label-nameplate | `label-v1` | 1 | plate | no | yes |
| label-nameplate | `label-v1` | 1 | document_kind | no | yes |

## Paper outline for the receipt crop (Q11)

What the worker's `cropToPaper` would do with the outline (it skips one that is
under 20% on a side or over 97% on both). `cuts_paper`: the crop would remove part of
the receipt (under 98% of the paper kept). `good`: kept and IoU ≥ 0.8.

| Case | Prompt | Run | IoU | Paper kept | Verdict |
|---|---|---|---|---|---|
| receipt-en | `receipt-v1` | 1 | 0.49 | 49% | **cuts_paper** |
| receipt-en | `receipt-v2` | 1 | 1.00 | 100% | no_crop |
| receipt-ar | `receipt-v1` | 1 | – | – | missing |
| receipt-ar | `receipt-v2` | 1 | 0.49 | 49% | **cuts_paper** |
| receipt-table | `receipt-v1` | 1 | 0.37 | 39% | **cuts_paper** |
| receipt-table | `receipt-v2` | 1 | 0.65 | 67% | **cuts_paper** |

## What the code checks removed

| Mode | Prompt | Field: reason | Times |
|---|---|---|---|
| label | `label-v1` | vin: vin_format | 1 |
| receipt | `receipt-v2` | warranty_terms_printed: low_confidence | 1 |

## Runs

| Case | Mode | Prompt | Run | Status | Fields right | Requests | In | Out | Reasoning | Cost | Latency (ms) | Finish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt-en | receipt | `receipt-v1` | 1 | ok | 3/6 | 1 | 2218 | 620 | 314 | 0.004254 | 2041 | stop |
| receipt-en | receipt | `receipt-v2` | 1 | ok | 3/6 | 1 | 2221 | 556 | 255 | 0.004001 | 1945 | stop |
| receipt-ar | receipt | `receipt-v1` | 1 | ok | 5/6 | 1 | 2218 | 724 | 456 | 0.00467 | 2275 | stop |
| receipt-ar | receipt | `receipt-v2` | 1 | ok | 4/6 | 1 | 2221 | 1308 | 1024 | 0.007009 | 3414 | stop |
| receipt-table | receipt | `receipt-v1` | 1 | ok | 5/6 | 1 | 2218 | 858 | 427 | 0.005206 | 2503 | stop |
| receipt-table | receipt | `receipt-v2` | 1 | ok | 5/6 | 2 | 2221 | 860 | 453 | unknown | 3207 | stop |
| label-nameplate | label | `label-v1` | 1 | ok | 6/6 | 1 | 2189 | 518 | 407 | 0.003823 | 1766 | stop |
| label-registration-ar | label | `label-v1` | 1 | ok | 0/6 | 1 | 2189 | 1029 | 1024 | 0.005867 | 2825 | stop |
| reading-odometer | reading | `reading-v1` | 1 | paused (rate_limited) | – | 2 | 0 | 0 | 0 | unknown | 537 | – |
| thing-drill-box | thing | `thing-v1` | 1 | paused (rate_limited) | – | 1 | 0 | 0 | 0 | unknown | 335 | – |
| thing-mug | thing | `thing-v1` | 1 | not_run (budget_calls) | – | 0 | 0 | 0 | 0 | 0 | 0 | – |
| multi-shelf | multi | `multi-probe-v1` | 1 | not_run (budget_calls) | – | 0 | 0 | 0 | 0 | unknown | 0 | – |

**Total:** 12 request(s), cost unknown.

## Addendum (added by hand after the run, from its answers)

The harness above is as the run printed it. What follows was worked out afterwards from the
same answers with the harness's own functions, and the harness now reports it itself.

**Two runs, one set.** This run hit its 12-request cap before `reading-odometer`, the two things
and the shelf could be answered: Groq refused `reading-odometer` twice and `thing-drill-box` once
with HTTP 429 "Request too large … on output tokens per minute (OTPM): Limit 1000" (the rest
of the message was cut at 200 characters by callModel's log), each at least 65 s after the last
answer, with `x-ratelimit-remaining-tokens: 8000`. `receipt-table · receipt-v2` needed a
second request for the same reason. Those four cases are in
[`2026-09-29-groq-qwen-qwen3.8-27b-2.md`](2026-09-29-groq-qwen-qwen3.8-27b-2.md), run 150 s
apart. Three earlier diagnostic requests (receipt-en: `receipt-v1` once, two drafts of v2) and
one refused request are not in either report; their answers agree with the ones here.

**Cost.** The run printed "unknown" wherever a refused request had no price; a refused request
has no tokens and is counted as costing nothing now. The eight answers cost 0.040047 USD
(`receipt-table · receipt-v2`'s answer: 2,221 in, 860 out, 0.005217 USD). All 20 requests of
the day, both reports and the diagnostics: about 0.066 USD.

**Reasoning stops at 1,024 tokens.** `receipt-ar · receipt-v2` and `label-registration-ar`
used exactly 1,024 reasoning tokens (so did the shelf in run -2); the registration card came
back as an empty object. Inferred: Groq's `low` reasoning effort caps reasoning at 1,024
tokens, and an answer that reaches the cap is degraded, not truncated (finish reason `stop`).

**The paper outline read against the longer side.** The outlines' short-side coordinates fit a
model that measures against the photo's longer side, as if the photo were padded to a square
(the shelf in run -2 fits it exactly). Rescaled that way:

| Case | Prompt | IoU | Verdict | IoU, longer side | Paper kept, longer side | Verdict, longer side |
|---|---|---|---|---|---|---|
| receipt-en | `receipt-v1` | 0.49 | **cuts_paper** | 0.69 | 69% | **cuts_paper** |
| receipt-en | `receipt-v2` | 1.00 | no_crop | 1.00 | 100% | no_crop |
| receipt-ar | `receipt-v1` | – | missing | – | – | missing |
| receipt-ar | `receipt-v2` | 0.49 | **cuts_paper** | 0.69 | 69% | **cuts_paper** |
| receipt-table | `receipt-v1` | 0.37 | **cuts_paper** | 0.54 | 56% | **cuts_paper** |
| receipt-table | `receipt-v2` | 0.65 | **cuts_paper** | 0.93 | 94% | **cuts_paper** |

Even rescaled, four outlines of five would cut the receipt. **The crop stays off for Groq
`qwen/qwen3.8-27b`.**

**Warranty terms.** `receipt-en` got warranty terms in both versions at 0.9, a placeholder and
the receipt's thank-you line, and T10's checks kept both. The check added with this report
(checks.ts `notWarrantyTerms`: the text must name a warranty or guarantee in one of Kept's five
languages, and must not say there is none or talk about the model) drops both, and the
invented sentence of the first diagnostic request (confidence 1.0). Warranty terms always wait
for review (D19), so these were wrong suggestions, not stored values.
