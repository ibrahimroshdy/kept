# Receipt date and currency: temperature and wire schema, groq `qwen/qwen3.8-27b`, 2026-09-29

A follow-up to [`2026-09-29-groq-qwen-qwen3.8-27b.md`](2026-09-29-groq-qwen-qwen3.8-27b.md) (T11),
where receipts left out the currency 5 times in 6 and the date 3 times in 6 across two prompt
wordings. T11 inferred two causes: (a) the worker's simplified wire schema, where the spike that
read both sent a schema with a date pattern; (b) the sampling temperature, which callModel does
not send. Numbers and case ids only.

- **Set:** the committed synthetic set (`synthetic-2026-09-29`), the three receipt cases,
  `receipt-en`, `receipt-ar` and `receipt-table`, one answer each per variant. Synthetic photos
  and three samples: this settles nothing about real receipts.
- **Prompt:** `receipt-v1` (the worker's) throughout. Reasoning low.
- **Requests:** 8, the cap set for this experiment: 6 answers and 2 refusals. 0.032492 USD.
- **Runs:** [`-3`](2026-09-29-groq-qwen-qwen3.8-27b-3.md) (temperature 0),
  [`-4`](2026-09-29-groq-qwen-qwen3.8-27b-4.md) and [`-5`](2026-09-29-groq-qwen-qwen3.8-27b-5.md)
  (the `receipt-required` wire schema, split in two by the refusals below).

## Variants

| Variant | Temperature | Wire schema |
|---|---|---|
| baseline (T11's run, `receipt-v1` rows) | the provider's default | `simple`: only `lines` required |
| (i) | **0** (harness `--temperature 0`) | `simple` |
| (ii) | the provider's default | **`receipt-required`**: `date` and `currency` required too, dates with the pattern `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` (harness `--wire receipt-required`) |
| (iii) both | 0 | `receipt-required` — **not run**: the 8-request cap was reached |

## Results

Fields right are after Kept's code checks (checks.ts), out of six per receipt: vendor, date,
currency, total, lines, warranty terms (which must stay empty on two of the three).

| Variant | Date read | Currency read | Fields right | Vendor, total, lines | Warranty terms right | Output tokens per answer (mean) | Reasoning tokens | Cost per answer (mean, USD) |
|---|---|---|---|---|---|---|---|---|
| baseline | 2/3 | 1/3 | 13/18 | 9/9 | 1/3 | 620, 724, 858 (734) | 314, 456, 427 | 0.004710 |
| (i) temperature 0 | **0/3** | **0/3** | 11/18 | 9/9 | 2/3 | 627, 732, 781 (713) | 320, 447, 394 | 0.004627 |
| (ii) `receipt-required` | **3/3** | **3/3** | **17/18** | 9/9 | 2/3 | 1,080, 908, 1,334 (1,107) | 754, 478, 1,024 | 0.006203 |

- Every date and currency read under (ii) was right after the checks, at confidence 0.92–0.98;
  the bare `$` stayed ambiguous, as D189 requires.
- The one field (ii) got wrong is the warranty terms on `receipt-table`, kept at 0.90: the same
  kind of miss as the baseline's (T11 addendum), not something the schema touches.
- The baseline's warranty column is T11's, scored before the `notWarrantyTerms` check existed;
  (i) and (ii) ran with it.
- At temperature 0 the model left out the date and the currency on all three receipts, including
  `receipt-table`, which the baseline read. Temperature is not the cause.

## Decision

**(ii) is adopted for the worker**: `WIRE_IN_USE = 'receipt-required'` in
`apps/server/src/ai/wire.ts`. `simple` stays selectable (`--wire simple` in the harness,
`ExtractRequest.wire` in code). Temperature stays unset: 0 made things worse.

What (ii) costs, and why it is still taken:

- **Longer answers.** Mean 1,107 output tokens against 734, most of it reasoning (the Arabic
  receipt reached 1,024 reasoning tokens, the cap T11 inferred for `low`). Cost per answer about
  +32%.
- **Groq's refusals.** Two of the three answers passed 1,000 output tokens, and after the first
  of them Groq refused the next two requests (about 150 s and 270 s later) with "Request too
  large … (OTPM): Limit 1000, Requested 1080". A refusal pauses the job without spending an
  attempt, and the pacer now holds the key a full minute per refusal, doubling (see below), so
  this costs time, not captures.
- **A required field the receipt doesn't have.** The model must now write a date and a currency
  even when none is printed. None of the three cases lacks them, so this is unmeasured. A date
  and a currency always wait for review (D19), so an invented one is a wrong suggestion, not a
  stored value; its confidence should be watched on real receipts.

Check this on the maintainer's real receipts before building anything else on it.

## Groq's output-token refusal, and `maxOutputTokens`

The refusal was logged in full for the first time in this run (callModel now keeps a 429's
whole message, the key and organisation id removed):

> Request too large for model `qwen/qwen3.8-27b` … on output tokens per minute (OTPM): Limit
> 1000, Requested 1080. The request's expected output tokens exceed the enforced limit; reduce
> max_tokens (or the request's expected output) and try again.

It came with no `retry-after`, and with the TPM window empty (`x-ratelimit-remaining-tokens:
8000`).

**Does a refusal mean the request's `maxOutputTokens` passes the limit?** Not on the evidence.
The worker's receipt cap is `outputTokenCap('receipt', 'low')` = 2,500 + 2,048 = **4,548**. The
model allows 16,384 completion tokens (Groq's model listing,
`docs/spikes/code/step3/server/models-groq-2026-09-26.json`). The key's OTPM is 1,000, learned
only from the 429. With that cap, Groq answered 12 of the 15 receipt requests in T11's run and
this one; each of the 3 refusals came within minutes of an answer of more than 1,000 tokens. In
all six refusals recorded today (receipts, the odometer, a thing), "Requested" was the output of
the largest answer the key had had in the last few minutes (1,308 once, 1,029 three times, 1,080
twice), never the request's `max_tokens` (2,248 to 4,548).

Inferred, not documented: Groq expects a request to produce as much as the key's largest recent
answer, capped by `max_tokens` (hence "reduce max_tokens"), and refuses outright when that alone
passes the limit. The refusals continued for minutes, 65 s to 150 s apart.

**The reservation is not changed.** Capping `maxOutputTokens` at the learned 1,000 would
probably stop the refusals (inferred from Groq's advice). But answers of more than 1,000 tokens
would then end as `length` failures: five of the eighteen answers in today's reports, and two of
the three receipts under (ii).

A narrower option is left open: retry once with `max_tokens` at the learned limit after a
refusal. The database pacer would need to return the learned limit from `kept.ai_key_admit`,
which is a migration.

Kept's own pacer reserves `expectedOutputTokens` = 2,500 for a receipt (`MAX_OUTPUT_TOKENS`),
also above 1,000. Once a limit is learned, each receipt therefore waits for the key's output
window to end, at most a minute. That is slower than needed but never stuck.
