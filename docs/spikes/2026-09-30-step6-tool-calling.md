# Spike S6.3: tool calling through `callModel`'s shape

Date: 2026-09-30. Step-6 plan, Task 0 (it feeds T8, T13 and T17). Result: **PASS.**
- **Mock (14 of 14 checks):** with no `execute` and `stopWhen: isStepCount(1)`, each `generateText`
  makes **exactly one** provider request (a counting `MockLanguageModelV4`), whether the step returns
  a tool call, two parallel tool calls, an invalid call or text. That holds with `stopWhen` left
  out too, since the default is `isStepCount(1)`.
- **Real provider (Groq `openai/gpt-oss-120b`, `reasoning: 'low'`):** it answered a two-step question
  in English and in Arabic. Each turn took three requests: two tool steps, then the answer. A turn
  used about 3,000 input tokens and 137 or 192 output tokens. That is **well inside** the 8,000
  tokens a minute and the 1,000 output tokens a minute (V36). **Groq fits a turn in one minute's
  windows**, so the "slow on this tier" fallback isn't needed. `DEFAULT_MODELS.groq.assistant`
  stays `untested` until T17's eval, as the plan says.
- **D213 (a spoken list):** "In the garage I have a drill, a ladder and two paint cans" (and the same
  in Arabic) made **one** `add_thing` call, for the drill only, in each language. The model didn't
  emit parallel calls for a list. See finding 6.
- The real calls used **8 of the 8-call budget**. They were spaced 61 s apart, each capped at 900
  output tokens. The key was read from the git-ignored `.env` and never printed. OpenAI, Anthropic
  and Google weren't called (no keys, and the instruction was Groq only).

Code: `docs/spikes/code/step6/toolcall/`:
- `tool-calling.mock.spike.ts`: the mock checks, with `mock-results.json` (the shapes, verbatim).
- `tool-calling.groq.spike.ts`: the two-step turns (6 calls).
- `multi-add.groq.spike.ts`: D213 (2 calls).
- `groq-results.jsonl`: one line per real call, with tokens, latency, the rate headers and the
  answer.
- `package.json` + `package-lock.json`: `ai` 7.0.116, `@ai-sdk/groq` 4.0.50, `@ai-sdk/provider`
  4.0.18, `@ai-sdk/provider-utils` 5.0.49, zod 4.6.5.

All three scripts typecheck (`tsc --noEmit --strict`, exit 0).

## The shapes T8 builds on (read from `ai` 7.0.116's `.d.ts` and observed)

| Question | Answer |
|---|---|
| Where tool calls are read | `result.toolCalls: {type: 'tool-call', toolCallId, toolName, input}[]`. `input` is already parsed JSON. For a call the SDK rejected, the same array also carries `invalid: true` and `error` |
| `finishReason` for a tool call | `'tool-calls'`; `rawFinishReason` `'tool_calls'` on Groq; `result.text` is `''` |
| One request per call | Yes: `doGenerate` ran once in every case. `result.steps.length === 1`; no tool results (`toolResults: []`, nothing executes) |
| **Input failing the schema** | **Depends on the schema.** With `jsonSchema(s)` and **no `validate`**, the SDK checks nothing: `{"location_id":"x"}` against `required: ['query']` came back as a valid call. With a **zod** `inputSchema` it came back as `toolCalls[0].invalid === true`, `error.name === 'AI_InvalidToolInputError'`, plus a `tool-error` part in `result.content`. **Nothing is thrown**; `finishReason` stays `'tool-calls'` |
| An invented tool name | Not thrown: `toolCalls[0]` has `invalid: true`, `dynamic: true`, `error: AI_NoSuchToolError` (with `availableTools`), plus a `tool-error` content part |
| The assistant tool-call message for the next request | `result.response.messages` = `[{role: 'assistant', content: [{type: 'reasoning', text}, {type: 'tool-call', toolCallId, toolName, input}]}]`. Append it as is |
| The tool result message | `{role: 'tool', content: [{type: 'tool-result', toolCallId, toolName, output: {type: 'json', value}}]}` (`ToolResultOutput` also has `text`, `error-text`, `error-json`, `execution-denied`) |
| What the provider receives | `prompt` = system, user, assistant (reasoning + tool-call), tool (tool-result), in that order; `tools` = `[{type: 'function', name, description, inputSchema}]`; `toolChoice` = `{type: 'auto'}` |
| Usage per step | Yes, one step per call: `result.usage` (= `totalUsage`) with `inputTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens`, `inputTokenDetails.cacheReadTokens` |
| Reasoning parts | `@ai-sdk/groq` sends an assistant message's reasoning parts back as `reasoning` on that message ("groq supports reasoning for tool-calls in multi-turn conversations", its source comment); Groq accepted them |

## Real provider: Groq, the maintainer's development key's tier

A member's tool set: the nine read tools of T1 (`capabilities`, `list_locations`, `search_things`,
`where_is`, `get_thing`, `list_contents`, `thing_history`, `find_documents`, `upcoming`) plus
`move_thing`, `mark_seen` and `log_reading`, 12 in all, as JSON schemas. The tool results were
fixtures in Kept's envelope, with names under `untrusted`.

| Turn | Step | Tools called | Input tokens | Output (reasoning) | Latency | `x-ratelimit-remaining-tokens` |
|---|---|---|---|---|---|---|
| en "Where is the drill, and who had it last?" | 1 | `search_things {query: "drill"}` | 855 | 41 (12) | 0.66 s | 6,964 |
| | 2 | `thing_history {id: "K7D2QX", limit: 5}` | 979 | 36 (5) | 0.74 s | 6,980 |
| | 3 | answer | 1,171 | 60 (n/a) | 1.19 s | 6,570 |
| ar "وين الشنيور؟ ومين آخر واحد استلفه؟" | 1 | `search_things {query: "شنيور", limit: 5}` | 857 | 67 (30) | 1.35 s | 7,102 |
| | 2 | `thing_history {id: "K7D2QX", limit: 5}` | 1,012 | 40 (9) | 1.16 s | 6,921 |
| | 3 | answer | 1,160 | 85 (n/a) | 2.30 s | 6,639 |

- **The tool definitions cost about 800 input tokens.** 12 tools plus the four-line instructions
  and the question came to 855. Each later step adds its history, roughly 120 to 200 tokens a step
  here.
- **Reasoning at `low` was 5 to 30 tokens a tool step**, and none was reported on the answer step.
  `REASONING_ALLOWANCE.low` (2,048) is far above this. T8's `MAX_OUTPUT_TOKENS.assistant = 1200`
  is ample; the estimate of 400 output tokens for a tool step and 800 for an answer is
  conservative by about 10×. Keep it: the pacer only over-reserves.
- **Rate headers** as in step 3: `x-ratelimit-limit-tokens: 8000`, `-remaining-tokens`,
  `-reset-tokens` (7.7 s to 10.7 s here), and `-limit-requests: 1000` with a reset of minutes
  (per day, inferred in step 3). **No header describes the 1,000-output-token window**, so the
  pacer's OTPM rule (step 3, 0045) stays as it is.
- **The answers (for T17, not the pass condition):**
  - en: "The drill is in the Garage → Shelf 2 [K7D2QX](/t/K7D2QX). It was last returned by Louis on 2026‑09‑12 [history](/t/K7D2QX)."
  - ar: "الشنيور اللاسلكي موجود في الرف ٢ بالمخزن ببيت العائلة [0192a1b2](/t/K7D2QX). آخر من استلفه هو ألفريد …"
  - Both answer in the question's language and cite internal links, but both **get "who had it
    last" wrong**. The fixture's history says it was lent to Murdock; the model named who recorded
    the event (Louis, Alfred). The link texts are a short code or a UUID prefix, not the thing's
    name, against the instruction. Both go into T17's cases.

## Findings for the plan

1. **One request per call is the SDK's behaviour, not only its default.** Set
   `stopWhen: isStepCount(1)` explicitly anyway (T8 step 3), and never pass `execute`,
   `toolApproval`, `repairToolCall` or `prepareStep`: the mock proves the single request with none
   of them.
2. **Validation is Kept's job.** A tool whose `inputSchema` is `jsonSchema(s)` without `validate`
   is never checked by the SDK. T8's `toToolSet(defs)` should build `jsonSchema(s, {validate})`
   from `@kept/mcp`'s zod input (or pass the zod schema itself), so a bad call arrives as
   `invalid: true`. **T9's `runTool` validates again with the same zod input regardless** (the MCP
   path has no SDK in front).
3. **T8's outcome table, corrected:** a tool name not in `defs`, or input failing its schema, is
   **not thrown**. It comes back as a call with `invalid: true` and `error.name`
   (`AI_NoSuchToolError` or `AI_InvalidToolInputError`), `finishReason: 'tool-calls'`, one request.
   Map it to `schema_invalid` / `tool_input` by reading `toolCalls[i].invalid`, not by catching.
   Valid calls in the same step still run (T13 decides whether a step with one invalid call runs
   the valid ones; recommended: yes, and tell the model about the invalid one in its tool result).
4. **The thread stores the parts the SDK returns** (`reasoning` + `tool-call`), and the next request
   sends them back. `@kept/shared`'s `Part` (T1 step 4) has no reasoning part. Either add
   `{type: 'reasoning', text}` (kept in the private thread, never shown and never in the ledger), or
   drop reasoning from history: Groq accepted history with it; without it wasn't tested. Recommended:
   store it. Reasoning text is model output about the user's question and falls under D23's thread
   privacy and D206's ledger rule.
5. **The Groq default is fine for the assistant on this tier.** No change to the pacer. S6.3's
   pass condition is met on one provider. The others stay "untested" (device row V36, S6.3).
6. **D213 needs a tool shape, not a loop.** Asked to add three things, the model proposed one
   (`add_thing {name: "drill", place: "Garage", quantity: 1}`), and the same in Arabic. With one
   request per step, collecting a list by looping would cost a model call per item and still
   depend on the model to keep going. **Recommended for T1 and T13:**
   - give `add_thing` an `items: [{name, quantity, place}]` array (1 to 20), or add a separate
     `add_things`;
   - T20's card renders one row per item, with one Confirm and one Undo.

   **This is one sample per language**; T17's eval should hold several list phrasings. A prompt
   line ("call `add_thing` once per thing") was in the tool description and didn't help.

## What changes in the plan

- **T8:** findings 1–3. `convert.ts` builds validating schemas. The outcome table reads `invalid`.
  `MAX_OUTPUT_TOKENS.assistant` and the output estimates stay.
- **T1 step 4:** a `reasoning` part (finding 4). **T1 step 1:** `add_thing` takes a list, or
  `add_things` is added (finding 6, D213).
- **T13:** a step with invalid calls runs the valid ones and returns a `{error, hint}` result for
  each invalid one.
- **T17:** add the "who had it last" (borrower vs recorder) case, the link-text check, and D213's
  list phrasings in English and Arabic.
