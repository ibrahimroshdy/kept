# Extraction evaluation: groq `qwen/qwen3.8-27b`, 2026-09-29

Written by `pnpm eval:extraction` (apps/server/eval). Numbers and case ids only: no
extracted text, expected values or images.

- **Date:** 2026-09-29 (10:26–10:31 UTC)
- **Provider:** groq, model `qwen/qwen3.8-27b`, reasoning low, temperature **0**, a harness experiment: the worker sends none
- **Prompts:** receipt `receipt-v1`
- **Cases:** `synthetic-2026-09-29`, 9 case(s), 3 run(s), **synthetic photos** (a smoke set: it proves nothing about real photos)
- **Requests:** 3 sent, 0 held back by the pacer or the budgets; limits: at most 3 requests, 0.5 USD, ≥ 150 s apart, ≤ 1000 output tokens a minute
- **Price:** `groq-listing-2026-09-26`: 0.8 in / 4 out / 0.4 cached USD per million tokens

Scoring (apps/server/eval/score.ts): accuracy, precision and recall are on the fields
Kept keeps after its code checks (checks.ts); calibration is on the model's raw answer.
A false accept is a wrong value Kept keeps at confidence ≥ 0.6 (D19). A field the case
expects empty counts as right only when it stays empty.

## Summary per mode and prompt

| Mode | Prompt | Runs ok | Fields right | Precision | Recall | False accepts | Auto-accept false accepts | ECE | Brier | Length stops | Tokens in / out (reasoning) per run | Cost per run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt | `receipt-v1` | 3/3 | 11/18 (61%) | 90% | 56% | 1/10 | – | 0.21 | 0.21 | 0 | 2218 / 713 (387) | 0.004627 |

Cost is in USD, from the in-memory call ledger (callModel's own cost, D206).

## Fields

### receipt · `receipt-v1` (3 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| vendor | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| date | 3 | 0/3 | – | 0% | 0 | 0 | 0 | – | – |
| currency | 3 | 0/3 | – | 0% | 0 | 0 | 0 | – | – |
| total | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| lines | 3 | 3/3 | 100% | 100% | 3 | 0 | 0 | 0.97 | – |
| warranty_terms_printed | 3 | 2/3 | 0% | 0% | 1 | 1 | 2 | – | 0.92 |

## Confidence calibration (raw answers)

| Mode | Prompt | Confidence | Values | Mean confidence | Right |
|---|---|---|---|---|---|
| receipt | `receipt-v1` | 0.90–0.95 | 2 | 0.90 | 0% |
| receipt | `receipt-v1` | 0.95–1.00 | 10 | 0.97 | 90% |

## Fields that must stay empty

The regression checks: a field the photo does not have (warranty terms that are not
printed, a VIN on a TV nameplate…).

| Case | Prompt | Run | Field | The model filled it | Kept kept it out |
|---|---|---|---|---|---|
| receipt-en | `receipt-v1` | 1 | warranty_terms_printed | yes | yes |
| receipt-ar | `receipt-v1` | 1 | warranty_terms_printed | yes | yes |

## Paper outline for the receipt crop (Q11)

What the worker's `cropToPaper` would do with the outline (it skips one that is
under 20% on a side or over 97% on both). `cuts_paper`: the crop would remove part of
the receipt (under 98% of the paper kept). `good`: kept and IoU ≥ 0.8. The last two
columns read the same outline as measured against the photo's longer side (score.ts
`fromLongSide`): a measurement of a systematic error, not what the worker does.

| Case | Prompt | Run | IoU | Paper kept | Verdict | IoU, longer side | Verdict, longer side |
|---|---|---|---|---|---|---|---|
| receipt-en | `receipt-v1` | 1 | 0.50 | 50% | **cuts_paper** | 0.71 | **cuts_paper** |
| receipt-ar | `receipt-v1` | 1 | 0.40 | 40% | **cuts_paper** | 0.55 | **cuts_paper** |
| receipt-table | `receipt-v1` | 1 | 0.61 | 65% | **cuts_paper** | 0.86 | **cuts_paper** |

## What the code checks removed

| Mode | Prompt | Field: reason | Times |
|---|---|---|---|
| receipt | `receipt-v1` | warranty_terms_printed: not_terms | 1 |
| receipt | `receipt-v1` | warranty_terms_printed: placeholder | 1 |

## Runs

| Case | Mode | Prompt | Run | Status | Fields right | Requests | In | Out | Reasoning | Cost | Latency (ms) | Finish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt-en | receipt | `receipt-v1` | 1 | ok | 4/6 | 1 | 2218 | 627 | 320 | 0.004282 | 2001 | stop |
| receipt-ar | receipt | `receipt-v1` | 1 | ok | 4/6 | 1 | 2218 | 732 | 447 | 0.004702 | 2117 | stop |
| receipt-table | receipt | `receipt-v1` | 1 | ok | 3/6 | 1 | 2218 | 781 | 394 | 0.004898 | 2453 | stop |

**Total:** 3 request(s), 0.013882 USD.

## Addendum (added by hand after the run)

Variant (i), temperature 0, of the receipt date and currency experiment. The comparison and the decision are in [`2026-09-29-groq-receipt-date-currency.md`](2026-09-29-groq-receipt-date-currency.md).
