# Step 7, Task 0: alias batches on Groq (E1)

Run on 2026-09-30 with the maintainer's development Groq key (from the git-ignored `.env`, never
printed), model `qwen/qwen3.8-27b`, six calls in all. Plan:
[step 7](../plans/2026-09-30-step-7-portability.md), Task 0 and Task 15. The limit it's measured
against: **1,000 output tokens a minute** on the development tier (V36).

**Result: a batch of 20 names fits (680 and 731 output tokens against 900), but only with no
reasoning, and only if `max_tokens` is at most 900. English aliases were good for 40 of 40
names; the Arabic ones were not good enough to accept without review.**

## How

`docs/spikes/code/step7/e1_alias.ts` calls `generateText` exactly as `apps/server/src/ai/call.ts`
does: the server's own `modelFor()` and `callSettingsFor()` (`ai/providers.ts`), `Output.object`
with a JSON schema, Groq's structured outputs, `maxRetries: 0`. The prompt (the draft for T15's
`prompt.ts`) sends numbered names and asks, per name, for at most N aliases in each of the
location's languages (`en`, `ar` here), under four words, not the name itself, not the brand
alone, no model numbers alone, no URLs or ids. Answers come back **by index**; the model never
sees an id (L51). Every answer is checked by `e1_check.py` (below).

Names: 20 English (`Samsung QA55Q60 TV`, `Makita DHP485 cordless drill`, `Allen key set`, …) and 20
Arabic (`غسالة سامسونج`, `دلة قهوة`, `ريموت التلفزيون`, …), listed in `e1_alias.ts`.

## The six calls

| # | Time (UTC) | Batch | Reasoning | Aliases per language | Input | Output (of which reasoning) | Result |
|---|---|---|---|---|---|---|---|
| 1 | 23:03:44 | 10 English | low | 3 | 237 | **1,089** (592) | answered; over the minute's budget alone |
| 2 | 23:05:29 | 10 Arabic | low | 2 | — | — | **429 before running**: "Request too large … on output tokens per minute (OTPM): Limit 1000, Requested 1089. … reduce max_tokens" |
| 3 | 23:06:09 | 10 Arabic | low | 2 | 225 | 756 (388) | answered, `max_tokens` 900 from here on |
| 4 | 23:10:41 | 10 English | none | 2 | 204 | 384 (—) | answered |
| 5 | 23:12:34 | 20 Arabic | none | 2 | 285 | **680** (—) | answered |
| 6 | 23:13:02 | 20 English | none | 2 | 303 | **731** (—) | answered |

- **`max_tokens` above the minute's limit is refused outright.** Calls 1–2 asked for 1,800. Groq
  refused call 2 with its "Request too large" OTPM message, quoting 1,089 as "requested" (the
  size of call 1's answer, so Groq seems to estimate from recent output; *inferred*). From call 3
  on, `max_tokens` was 900 and nothing was refused.
- **Spacing.** Calls 5 and 6 were 28 s apart and 1,411 output tokens landed inside one minute
  without a refusal: the check that bit was the per-request one. That is one observation; T15's
  pacing still goes through step 3's pacer, which waits out the window.
- **Reasoning at `low` costs 390–590 tokens** of the 900 whatever the batch, which leaves room
  for about 8–10 names at two aliases per language. Without reasoning, a name costs about 34–38
  output tokens at two aliases per language (20 Arabic names: 680; 20 English: 731).
- **`reasoning: 'none'` isn't sent for this model.** `@ai-sdk/groq` 4.0.50 sends
  `reasoning_effort: "none"` only for `qwen/qwen3.6-27b`; for `qwen/qwen3.8-27b` it drops it and
  warns "reasoning "none" is not supported by this model" (`dist/index.js`). So calls 4–6 went out
  **with no `reasoning_effort` at all**, and Groq reported no reasoning tokens for any of them.
  The provider's default for this model does not reason (three calls; *observed, not documented*).
  T15 should say so explicitly: `reasoning: 'provider-default'` for `enrich_aliases`, not `'none'`,
  so the ledger records what was really sent.

## Quality

`e1_check.py` checks each alias mechanically: the language's script (Arabic letters for `ar`,
Latin for `en`), not the name itself, four words at most, no URL, not digits alone, the count per
language, and every index answered once.

```
-- en 0+10  reasoning=low  per-lang=3 out=1089 reasoning_tokens=592 indexes=ok flagged=0/60
-- ar 0+10: no answer (429)
   راوتر وي [ar] 'مودem': not Arabic script
-- ar 0+10  reasoning=low  per-lang=2 out=756  reasoning_tokens=388 indexes=ok flagged=1/40
-- en 10+10 reasoning=none per-lang=2 out=384  indexes=ok flagged=0/40
-- ar 0+20  reasoning=none per-lang=2 out=680  indexes=ok flagged=0/80
   Samsung QA55Q60 TV [ar] 'شاشة LED': not Arabic script
-- en 0+20  reasoning=none per-lang=2 out=731  indexes=ok flagged=1/80
```

The script catches mixed-script garbage (`مودem`) and flags a real alias (`شاشة LED`, which people
do type), so the script check should allow Latin acronyms inside Arabic. It can't tell a real
word from a wrong one. By reading every answer:

| Names | A useful alias in some language (the pass line: 18 of 20) | English aliases all sensible | Arabic aliases all sensible |
|---|---|---|---|
| 20 English, no reasoning (call 6) | **20 / 20** | 20 / 20 | 15 / 20 (wrong: `مسدس` and the non-word `متسدمة لاسلكية` for the drill, the same non-word for the Dyson, `فتاحة`/`مفك نجوم` for Allen keys, `طاقة واي فاي`, `طبق فرن`/`مشوي` for a cast-iron pot) |
| 20 Arabic, no reasoning (call 5) | **20 / 20** | 20 / 20 | 10 / 20 (the second Arabic alias is a non-word or wrong in 10: `علاقيه`, `حلم`, `اجمال`, `شانحة`, `مبة`, `مكشلة`, `جزاز`, `كيوت` twice, `زانة`, `عدول`) |
| 10 Arabic, reasoning low (call 3) | 10 / 10 | 10 / 10 | 6 / 10 (`فرنجة`, `غاطسة`, `جزار قهوة`, `كازرول`, and `مودem`) |

- **English aliases pass.** For every name, English or Arabic, the English aliases are what a
  person types: `washing machine`, `AC`, `power bank`, `dutch oven`, `hex key`.
- **Arabic aliases fail.** The first Arabic alias is usually a shorter real word, often taken from
  the name itself (`غسالة`, `مكيف`, `ثلاجة`), which helps. The second is often a non-word. Reasoning
  at `low` didn't fix it (6 of 10) and costs four times the tokens.
- **Pass line:** met as the plan words it (18 of 20 names with aliases a person would search by,
  both sets at 20/20), on the strength of the English aliases. **But auto-accepting the Arabic
  aliases (D19) would put non-words into Arabic search.**

## Decided for T15, and one question for the maintainer

- **Batch size 20**, two aliases per language, `max_tokens: 900`, `reasoning: 'provider-default'`
  on Groq (no reasoning tokens observed). The estimate shows about 40 output tokens a name.
- **`max_tokens` never above 900** for any Groq call on the development tier. Step 3's extraction
  calls already stay under it; T15's estimate should use 900 per call as the worst case.
- **Aliases are checked by script** before they're applied: the checks in `e1_check.py`, added to
  `extraction/checks.ts` `cleanAliases`. An `ar` alias must be mostly Arabic script, with Latin
  acronyms allowed; drop anything else, an alias equal to the name, over four words, a URL, or
  digits alone. It won't catch non-words.
- **Question (changes T15, D19 auto-accept):** Arabic aliases from `qwen/qwen3.8-27b` are wrong
  or non-words about a third of the time. Options: (a) auto-accept English aliases and show
  Arabic ones for review in the import summary; (b) ask for one Arabic alias, not two (the first
  was usually real); (c) accept both and let people delete bad ones. **Proposed: (b) plus (a)**,
  until the evaluation set (V1, V3) has an Arabic alias case that a model passes.
- The key isn't in any file this spike wrote. The raw answers are in
  `docs/spikes/code/step7/out/e1-results.jsonl` (git-ignored, the organisation id redacted).
