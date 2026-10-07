# Extraction evaluation: groq `qwen/qwen3.8-27b`, 2026-09-29

Written by `pnpm eval:extraction` (apps/server/eval). Numbers and case ids only: no
extracted text, expected values or images.

- **Date:** 2026-09-29 (05:54–06:02 UTC)
- **Provider:** groq, model `qwen/qwen3.8-27b`, reasoning low, temperature the provider's default (callModel sends none; the worker's path)
- **Prompts:** reading `reading-v1` · thing `thing-v1` · multi `multi-probe-v1`
- **Cases:** `synthetic-2026-09-29`, 9 case(s), 4 run(s), **synthetic photos** (a smoke set: it proves nothing about real photos)
- **Requests:** 4 sent, 0 held back by the pacer or the budgets; limits: at most 4 requests, 0.5 USD, ≥ 150 s apart, ≤ 1000 output tokens a minute
- **Price:** `groq-listing-2026-09-26`: 0.8 in / 4 out / 0.4 cached USD per million tokens

Scoring (apps/server/eval/score.ts): accuracy, precision and recall are on the fields
Kept keeps after its code checks (checks.ts); calibration is on the model's raw answer.
A false accept is a wrong value Kept keeps at confidence ≥ 0.6 (D19). A field the case
expects empty counts as right only when it stays empty.

## Summary per mode and prompt

| Mode | Prompt | Runs ok | Fields right | Precision | Recall | False accepts | Auto-accept false accepts | ECE | Brier | Length stops | Tokens in / out (reasoning) per run | Cost per run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| reading | `reading-v1` | 1/1 | 0/3 (0%) | 0% | 0% | 1/1 | – | 0.97 | 0.94 | 0 | 1100 / 154 (129) | 0.001496 |
| thing | `thing-v1` | 2/2 | 11/11 (100%) | 100% | 100% | 0/7 | 0/7 | 0.06 | 0.00 | 0 | 1771 / 430 (273) | 0.003135 |
| multi (V2 probe) | `multi-probe-v1` | 1/1 | boxes 0/3 | – | – | – | – | – | – | 0 | 2125 / 1134 (1024) | 0.006236 |

Cost is in USD, from the in-memory call ledger (callModel's own cost, D206).

## Fields

### reading · `reading-v1` (1 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| value | 1 | 0/1 | 0% | 0% | 1 | 1 | 0 | – | 0.97 |
| unit | 1 | 0/1 | – | 0% | 0 | 0 | 0 | – | – |
| display | 1 | 0/1 | – | 0% | 0 | 0 | 0 | – | – |

### thing · `thing-v1` (2 run(s))

| Field | Scored | Right | Precision | Recall | Kept (≥ 0.6) | False accepts | Removed by checks | Mean confidence, right | Mean confidence, wrong |
|---|---|---|---|---|---|---|---|---|---|
| name (auto) | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.95 | – |
| brand (auto) | 2 | 2/2 | 100% | 100% | 1 | 0 | 0 | 0.95 | – |
| model (auto) | 2 | 2/2 | 100% | 100% | 1 | 0 | 0 | 0.90 | – |
| serial | 2 | 2/2 | – | – | 0 | 0 | 0 | – | – |
| aliases (auto) | 2 | 2/2 | 100% | 100% | 2 | 0 | 0 | 0.95 | – |
| colour (auto) | 1 | 1/1 | 100% | 100% | 1 | 0 | 0 | 0.95 | – |

## Confidence calibration (raw answers)

| Mode | Prompt | Confidence | Values | Mean confidence | Right |
|---|---|---|---|---|---|
| reading | `reading-v1` | 0.95–1.00 | 1 | 0.97 | 0% |
| thing | `thing-v1` | 0.90–0.95 | 1 | 0.90 | 100% |
| thing | `thing-v1` | 0.95–1.00 | 6 | 0.95 | 100% |

## Fields that must stay empty

The regression checks: a field the photo does not have (warranty terms that are not
printed, a VIN on a TV nameplate…).

| Case | Prompt | Run | Field | The model filled it | Kept kept it out |
|---|---|---|---|---|---|
| thing-drill-box | `thing-v1` | 1 | serial | no | yes |
| thing-mug | `thing-v1` | 1 | brand | no | yes |
| thing-mug | `thing-v1` | 1 | model | no | yes |
| thing-mug | `thing-v1` | 1 | serial | no | yes |

## Multi-item boxes (V2, measured only)

| Case | Run | Objects expected | Returned | Matched (IoU ≥ 0.5) | Named right | Mean IoU |
|---|---|---|---|---|---|---|
| multi-shelf | 1 | 3 | 3 | 0 | 0 | – |

## Runs

| Case | Mode | Prompt | Run | Status | Fields right | Requests | In | Out | Reasoning | Cost | Latency (ms) | Finish |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| reading-odometer | reading | `reading-v1` | 1 | ok | 0/3 | 1 | 1100 | 154 | 129 | 0.001496 | 1385 | stop |
| thing-drill-box | thing | `thing-v1` | 1 | ok | 5/5 | 1 | 1771 | 437 | 242 | 0.003165 | 1363 | stop |
| thing-mug | thing | `thing-v1` | 1 | ok | 6/6 | 1 | 1771 | 422 | 303 | 0.003105 | 1358 | stop |
| multi-shelf | multi | `multi-probe-v1` | 1 | ok | boxes 0/3 | 1 | 2125 | 1134 | 1024 | 0.006236 | 3015 | stop |

**Total:** 4 request(s), 0.014002 USD.

## Addendum (added by hand after the run, from its answers)

**The shelf's boxes are right when read against the longer side.** All three objects were
found and named right, with x and width right, but y and height at about two thirds of the
truth: the 1200×800 photo's coordinates were measured against its 1,200-pixel side. Rescaled
(score.ts `fromLongSide`, which the harness now reports itself): **3/3 matched at IoU ≥ 0.5,
mean IoU 0.86**. The receipts' outlines in the first report only partly fit this reading.
One synthetic photo proves nothing for V2; it says to test the longer-side reading on real
multi-item photos before building on the boxes.

**The odometer.** The seven-segment "052340 km" came back as 0.97 at confidence 0.97, with no
unit or display. The spike read the same image as 0.04340057 and as 52340, both at 0.98. V1 is
not met on this photo: a reading must keep waiting for review (D19), and its confidence means
nothing.

The first report's addendum explains why this second run exists (Groq's output-token 429s).
