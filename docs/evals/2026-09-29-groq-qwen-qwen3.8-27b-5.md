# Extraction evaluation: groq `qwen/qwen3.8-27b`, 2026-09-29

Written by `pnpm eval:extraction` (apps/server/eval). Numbers and case ids only: no
extracted text, expected values or images.

- **Date:** 2026-09-29 (10:45–10:50 UTC)
- **Provider:** groq, model `qwen/qwen3.8-27b`, reasoning low, temperature the provider's default (callModel sends none; the worker's path)
- **Wire schema:** **`receipt-required`**, a harness experiment: the worker sends `simple` (ai/wire.ts)
- **Prompts:** receipt `receipt-v1`
- **Cases:** `synthetic-2026-09-29`, 9 case(s), 2 run(s), **synthetic photos** (a smoke set: it proves nothing about real photos)
- **Requests:** 2 sent, 0 held back by the pacer or the budgets; limits: at most 2 requests, 0.5 USD, ≥ 300 s apart, ≤ 1000 output tokens a minute
- **Price:** `groq-listing-2026-09-26`: 0.8 in / 4 out / 0.4 cached USD per million tokens

Scoring (apps/server/eval/score.ts): accuracy, precision and recall are on the fields
Kept keeps after its code checks (checks.ts); calibration is on the model's raw answer.
A false accept is a wrong value Kept keeps at confidence ≥ 0.6 (D19). A field the case
expects empty counts as right only when it stays empty.

## Summary per mode and prompt

| Mode | Prompt | Runs ok | Fields right | Precision | Recall | False accepts | Auto-accept false accepts | ECE | Brier | Length stops | Tokens in / out (reasoning) per run | Cost per run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt | `receipt-v1` | 2/2 | 11/12 (92%) | 91% | 91% | 1/11 | – | 0.10 | 0.08 | 0 | 2218 / 1121 (751) | 0.006258 |

Cost is in USD, from the in-memory call ledger (callModel's own cost, D206).

## Fields

### receipt · `receipt-v1` (2 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| vendor | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.98 | – |
| date | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.96 | – |
| currency | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.94 | – |
| total | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.96 | – |
| lines | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.96 | – |
| warranty_terms_printed | 2 | 1/2 | 0% | 0% | 1 | 1 | 0 | – | 0.90 |

## Confidence calibration (raw answers)

| Mode | Prompt | Confidence | Values | Mean confidence | Right |
|---|---|---|---|---|---|
| receipt | `receipt-v1` | 0.90–0.95 | 2 | 0.91 | 50% |
| receipt | `receipt-v1` | 0.95–1.00 | 9 | 0.97 | 100% |

## Fields that must stay empty

The regression checks: a field the photo does not have (warranty terms that are not
printed, a VIN on a TV nameplate…).

| Case | Prompt | Run | Field | The model filled it | Kept kept it out |
|---|---|---|---|---|---|
| receipt-ar | `receipt-v1` | 1 | warranty_terms_printed | no | yes |

## Paper outline for the receipt crop (Q11)

What the worker's `cropToPaper` would do with the outline (it skips one that is
under 20% on a side or over 97% on both). `cuts_paper`: the crop would remove part of
the receipt (under 98% of the paper kept). `good`: kept and IoU ≥ 0.8. The last two
columns read the same outline as measured against the photo's longer side (score.ts
`fromLongSide`): a measurement of a systematic error, not what the worker does.

| Case | Prompt | Run | IoU | Paper kept | Verdict | IoU, longer side | Verdict, longer side |
|---|---|---|---|---|---|---|---|
| receipt-table | `receipt-v1` | 1 | 0.62 | 66% | **cuts_paper** | 0.88 | **cuts_paper** |
| receipt-ar | `receipt-v1` | 1 | 0.33 | 33% | **cuts_paper** | 0.46 | **cuts_paper** |

## Runs

| Case | Mode | Prompt | Run | Status | Fields right | Requests | In | Out | Reasoning | Cost | Latency (ms) | Finish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| receipt-table | receipt | `receipt-v1` | 1 | ok | 5/6 | 1 | 2218 | 908 | 478 | 0.005406 | 3137 | stop |
| receipt-ar | receipt | `receipt-v1` | 1 | ok | 6/6 | 1 | 2218 | 1334 | 1024 | 0.00711 | 3511 | stop |

**Total:** 2 request(s), 0.012516 USD.

## Addendum (added by hand after the run)

The rest of variant (ii), the `receipt-required` wire schema, of the receipt date and currency experiment (see [`-4`](2026-09-29-groq-qwen-qwen3.8-27b-4.md)). The comparison and the decision are in [`2026-09-29-groq-receipt-date-currency.md`](2026-09-29-groq-receipt-date-currency.md).
