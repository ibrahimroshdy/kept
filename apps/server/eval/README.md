# The extraction evaluation harness

Measures how well an AI provider reads Kept's capture photos, per mode and per field, so the
product's open assumptions are settled on evidence (product design §19):

- **V1**: vision models read seven-segment odometers reliably;
- **V2**: providers return usable boxes for multi-item photos (1.x; measured only);
- **V3**: Arabic registration cards and receipts are read correctly;
- **V37**: Groq `qwen/qwen3.8-27b` is the cheapest *reliable* vision model;
- and whether the receipt's paper outline is good enough to turn the crop on (plan Q11;
  `ExtractionJobDeps.cropToPaper` is off until it is).

Reports are dated and committed under [`docs/evals/`](../../../docs/evals/).

## What it runs

The worker's path, without the database: the photo re-encoded by `extraction/image.ts`
(GPS-free; 3,072 px for evidence, 2,048 px for a thing) → the mode's prompt
(`extraction/prompts/`, any selectable version) → `extract()` → `callModel` (pacing, budgets,
the ledger row and the cost, on the in-memory ports) → `parseLenient` → `checks.ts`. Tokens and
cost are read back from the in-memory call ledger. The V2 probe (`multi.ts`) is evaluation only
and goes through the same `callModel` door.

## Running it

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH

# The mock provider (no network): the committed synthetic set and its mock answers.
pnpm eval:extraction --dir apps/server/test/fixtures/eval

# A real provider. The key is read from KEPT_EVAL_API_KEY only, never an argument or a file,
# and is never printed. Load it from the git-ignored .env in the same command:
( set -a; . ./.env; set +a; KEPT_EVAL_API_KEY="$KEPT_DEV_GROQ_API_KEY" \
    pnpm eval:extraction --dir eval-data --provider groq --model qwen/qwen3.8-27b \
      --prompt receipt=receipt-v1,receipt-v2 --gap-ms 65000 )
```

With `--dir` unset it reads `KEPT_EVAL_DIR`; with neither, or a folder that doesn't exist, it
prints `skipped: no evaluation folder` and exits 0. The normal test run only runs
`score.test.ts`, on the mock.

| Option | Default | |
|---|---|---|
| `--provider` | `mock` | `groq`, `openai`, `anthropic`, `google`, `openrouter`, `compatible` (with `--base-url`) |
| `--model` | | required for a real provider |
| `--reasoning` | `low` | as the worker's provider setting |
| `--prompt mode=v1,v2` | the version in use | repeatable; each case of that mode runs once per version |
| `--cases id*n,…` | every case once | `*n` repeats a case (reliability: the same photo, n answers) |
| `--max-calls` | 20 | requests sent, 429s included; the run stops before passing it |
| `--max-cost` | 0.50 | USD; `none` for no cap |
| `--gap-ms` | 5000 | between requests; never under 5 s for a real provider |
| `--output-tpm` | 1000 for `groq` | output tokens a minute the key allows; the run waits to stay under |
| `--price in,out[,cached]` | Groq's listing for `qwen/qwen3.8-27b` | USD per million tokens; unknown otherwise (cost reported unknown) |
| `--temperature` | none | **an experiment**: the worker sends no temperature; the report says when it was set |
| `--wire` | `receipt-required` | the wire schema variant (`src/ai/wire.ts`): `receipt-required`, the worker's, requires a receipt's date and currency and gives dates a `YYYY-MM-DD` pattern; `simple` requires only the lines; the report says when it isn't the worker's |
| `--out` | `docs/evals` | a second run the same day gets `-2`, `-3`… |
| `--no-report`, `--details <file>` | | `--details` writes the raw answers locally, for debugging; keep it out of Git |

**Groq's limits on the development key** (2026-09): 8,000 tokens a minute in total (an image
counts about 2,048) and 1,000 **output** tokens a minute. A receipt answer is 550–1,350 output
tokens, so leave at least a minute between receipts (`--gap-ms 65000`). A 429 is waited out once
and counts as a request.

**After an answer of more than 1,000 output tokens, Groq refuses requests for minutes** with
"Request too large … (OTPM): Limit 1000, Requested N", N being that answer's output (three
refusals 65 s apart after one such answer, two at about 150 s and 270 s after another). Leave five minutes after such an answer, or the run spends its calls on refusals.

## Cases

A folder of cases in either layout (both may be mixed):

1. **A manifest**, `cases.json` at the top of the folder (the committed set uses it):

   ```json
   { "set": "my-photos-2026-10", "cases": [
     { "id": "fridge-receipt", "file": "IMG_2041.jpg", "mode": "receipt",
       "languages": ["ar", "en"], "locationCurrency": "EGP",
       "expected": { "date": "2026-09-14", "currency": "EGP", "total": 1250 } }
   ] }
   ```

2. **One folder per case**: `<case>/image.jpg` (or `.jpeg`, `.png`, `.webp`, `.heic`,
   `doc.pdf`), `<case>/meta.json` (`{mode, languages, locationCurrency?, meter?}`) and
   `<case>/expected.json`.

`mode` is `thing`, `receipt`, `label`, `reading`, or `multi` (the V2 probe). A reading case can
give `"meter": {"kind": "distance", "unit": "km"}`, as the worker would.

**Expected values** are the engineering spec's §2.1 shape without confidences. Only listed
fields are scored.

- `{"anyOf": ["Cordless drill", "Drill"]}` lists acceptable answers.
- `null` means the field must be left out: the regression cases (warranty terms that aren't
  printed, a VIN on a nameplate).
- Currency is the code (`"EGP"`), or the ambiguity Kept must keep (`{"ambiguous": ["USD", "CAD"]}`
  for a bare `$`, D189).
- Aliases pass with one expected alias per language.
- `document_bbox` (the paper, `[x, y, w, h]` from 0 to 1) turns on the crop measurement.
- THING reads `objects[0]`. `multi` expects `objects: [{name, bbox}]`.

HEIC can't be decoded by the server's sharp, so a HEIC case is reported `skipped
(undecodable)`: the app would use the phone-made display instead. A PDF is skipped until the
harness gets T21's file text.

## Scoring (score.ts)

- **Right** after the code checks, which is what Kept stores or suggests: text equal after
  `normalize()` or a token ratio ≥ 0.9; codes equal without spaces; numbers within 0.5%;
  readings, dates and enums exact; lines matching in order.
- **Precision and recall** per mode and field. A wrong value counts against both.
- **False accepts**: a wrong value Kept keeps at confidence ≥ 0.6 (D19). For the auto-accept
  fields (name, brand, model, colour, type, aliases), it is the number that decides whether
  auto-accept is safe.
- **Calibration** on the raw answer: confidence bins against the share right, the expected
  calibration error (ECE) and the Brier score.
- **Paper outline**: IoU with the paper and what the worker's `cropToPaper` would do.
  `cuts_paper` means the crop would remove part of the receipt.
- **Multi-item** (V2): objects matched one to one at IoU ≥ 0.5, and the mean IoU.
- Tokens, cost, latency, finish reasons and length stops per run, from the ledger.

**When to turn the paper crop on.** Only for a provider and model whose report shows no
`cuts_paper` on the maintainer's real receipts (at least ten, some on a table and some filling
the frame), and `good` on those with a background. One `cuts_paper` is enough to keep it off:
a wrong crop hides part of the receipt.

## What the committed set is, and what it is not

`test/fixtures/eval/` holds nine **synthetic** photos rendered by `generate.mjs` from SVG, with
`cases.json` and the mock's answers (`mock-answers.json`, keyed by case id): English and
Arabic receipts (the Arabic one in Arabic-Indic digits), a receipt on a table with a bare `$`
and printed warranty terms, a TV nameplate, a synthetic Egyptian-style vehicle licence card, a
seven-segment odometer, two things and a three-object shelf. They are clean renders, so they
prove only that the pipeline runs and catch gross failures. **V1 and V3 are not proven by them.**

**Still needed from the maintainer**, in `eval-data/` at the repository root (git-ignored), with
a `cases.json`; at least 30 photos in all:

- a busy TV area, a shelf and a drawer (THING, and the V2 probe);
- real receipts: English and Arabic, printed and thermal, flat and crumpled, some filling the
  frame and some on a table, including a PDF;
- a real odometer: a seven-segment display, and an analog drum if a car has one;
- an Arabic car registration card (رخصة تسيير), front and back;
- a few nameplates and rating labels.

Run the set once per provider and commit each report. The reports hold numbers and case ids
only, never the photos or what was read from them.

## Regenerating the synthetic photos

```sh
node apps/server/test/fixtures/eval/generate.mjs
```

The drawing uses the Mac's fonts, so another machine renders different bytes. The mock keys its
answers by case id, and the harness keys each by the hash of the bytes it actually sends, so
the mock run doesn't depend on the bytes.

# The assistant and search evaluations (step 6)

`eval/assistant/` and `eval/search/` measure the assistant (D22, D123, D164, D179) and semantic
search (D200, D207) on the `households` seed. Each makes a throwaway database on the development
Postgres (5452), migrates it, seeds it, adds one instance AI provider and the cases' fixtures,
embeds every thing with the real backfill, runs, and drops the database.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH

# The mock (KEPT_AI_MOCK's scripted model and concept embedder): no network, no report.
pnpm eval:assistant
pnpm eval:search

# A real provider: the key from KEPT_EVAL_API_KEY only, never an argument; a dated report under
# docs/evals (numbers and case ids only). At least 5 s between cases.
( set -a; . ./.env; set +a; KEPT_EVAL_API_KEY="$<YOUR_KEY_VARIABLE>" \
    pnpm eval:assistant --provider openai --model <chat model> --embed-model <embeddings model> )
( set -a; . ./.env; set +a; KEPT_EVAL_API_KEY="$<YOUR_KEY_VARIABLE>" \
    pnpm eval:search --provider openai --embed-model <embeddings model> )
```

Put in the key variable your `.env` holds and models your key can call (`DEFAULT_MODELS` in
`@kept/shared` names Kept's defaults per provider).

- **Assistant cases** (`test/fixtures/assistant/cases.json`, 45): find, a cited figure, a secret,
  act (a card, never applied), a viewer asking for a change, cross-owner questions, prompt
  injection in notes and names, a location the person can't see, questions asked from a box or a
  location's page, and a link to a thing no tool showed. English and Arabic. Each case carries the
  script the mock plays (`src/ai/mock-script.ts`), so the mock run checks the loop, the cards, the
  refusals and the scoring, not a model. `--only id,…`, `--cases <file>` for your own.
- **Scoring** (`eval/assistant/score.ts`): tools called, cards (never executed), citations that
  resolve, no stray links, no figure that isn't in a tool result or the question, the answer's
  language, the viewer sentence, hidden locations, secrets not said, injection resisted; steps,
  tokens and cost per case from the ledger.
- **Search cases** (`test/fixtures/semantic/search-cases.json`, 62): queries found by their words
  and by their meaning, English and Arabic. Recall@10 and MRR for keyword-only search and for the
  provider's embeddings fused in; the local model (D207) column reads "not built" until S6.5's
  model ships. Add your own phrasings.
- `score.test.ts` in each folder runs the scoring maths and the whole harness on the mock in the
  normal test run.
