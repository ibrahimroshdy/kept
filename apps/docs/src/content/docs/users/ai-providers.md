---
title: AI providers
description: Which AI providers Kept works with, where keys go, what each feature sends and costs, spending limits, local models, and turning AI off.
---

Kept works without AI. Connecting a provider adds three things: naming things from photos and
reading receipts, labels and meter readings; the assistant, which answers questions about your
inventory; and, with an embeddings model, search by meaning. You bring your own key; Kept has no AI
service of its own.

## Providers

| Provider | Photos and receipts | Assistant | Search by meaning |
|---|---|---|---|
| **Groq** (recommended) | yes | yes | no embeddings model |
| **OpenAI** | yes | yes | yes |
| **Anthropic** | yes | yes | no embeddings model |
| **Google** (Gemini) | yes | yes | yes |
| **OpenRouter** | yes | yes | no embeddings model |
| **OpenAI-compatible** (Ollama, LM Studio, …) | the models you name | the models you name | if the server offers one |

**Groq with `qwen/qwen3.8-27b`** is the recommendation: the cheapest reliable result Kept measured,
about USD 0.004 a receipt (on synthetic test images, 2026-09-26). Pasting a Groq key selects it,
and **Why?** on the page gives the figures. Kept suggests a model for each provider and task; you
can pick any other from the provider's list under **Advanced**.

## Where the key goes

There are three places for a key, and no per-location key:

| Key | Set in | Pays for |
|---|---|---|
| **The account's key** | **Settings → AI**, by the account's owner | Every location that account owns |
| **Your personal key** | **Settings → AI → Personal AI key** | Your Personal location, your private assistant threads, and questions that span owners |
| **This server's key** | **Admin → AI**, by an instance admin | Anyone whose account has no key of its own |

Work in a location (naming a photo, an assistant answer about it) is paid by the **location's
owner**, so members of Alfred's "Family house" use Alfred's key, not their own. Members and
viewers see a read-only line saying who pays.

**Connecting:** paste the key in **Paste your key**. Kept recognises the provider from the key
where it can (otherwise choose it under **Advanced**), then **Save and test** checks that the model
reads photos and gives structured answers, and says what the test cost. Keys are write-only: Kept
never shows a saved key again, and **Replace key** swaps it. Before the first key on a server,
the instance admin has to save the [recovery kit](/admin/recovery-kit/): the key is a secret Kept
must be able to recover from a backup.

**Advanced** holds the provider and base URL, the model for each task (**Models**, loaded from the
provider's own list), **Reasoning effort** (low by default), the limits and the prices.

## What uses AI, and what it costs

AI settings open with **What uses AI in Kept**: a row per action (a captured photo, a receipt, a
label, a reading, an assistant question, a search, the test), with how many calls it makes, the
tokens it takes, and the cost from the price table, from your last 30 days' use once there is
some. Under **This month**, a bar per limit shows the spend so far.

- **Capture** (Thing, Receipt, Label, Reading modes): one call per photo. Names, brands, models
  and types are filled in; prices, dates, serials and readings wait in the Inbox as suggested
  values for you to accept. Each AI-filled draft carries a line such as "Read by qwen/qwen3.8-27b
  (Groq) · 2,502 tokens", with its cost and who paid.
- **The assistant** answers from your inventory within your role, and each tool it uses adds a
  call. Changes it proposes show as a confirmation card that you approve; for viewers it is
  read-only.
- **Search words after an import**: an import can offer **Add search words with AI?**, with the
  token estimate first ([import](/users/import-export/)).

**AI usage** pages list every call: **My AI usage** for everyone, a location's usage for its admins
and owner, the account's for its owner, and the instance's under Admin → AI. Each shows totals,
tokens by day stacked by task, breakdowns by task, person and location where they apply, and the
call list with **Export CSV**. A call records its
model, tokens, outcome and cost, never the prompt, the photo, the answer or the key.

Prices come from the **price table**, which instance admins edit in Admin → AI (with **Fill from
… listing** for providers that publish prices). The recommended Groq model's price is filled in
for you. A call with no price is counted in tokens and shown as cost unknown.

## Limits and pausing

Nothing is capped by money unless someone chooses to: after the first key Kept offers **Set a
monthly limit?** with a suggested amount, and **No limit**. Under **Advanced**, **Limits** holds:

- **Money a month** (in a currency the server has turned on) and **Tokens a month**, for the
  account; a location's own cap inside the account's, set by the owner; and a limit per person.
- Photo and receipt reading has a token budget of 60,000 tokens a minute, 2,000,000 a day and
  20,000,000 a month per paying account unless changed.
- **Pause AI** stops all calls by hand until you resume.

When a limit is reached, AI pauses for that scope only, with a banner such as "AI paused until
1 Oct · Home's monthly cap reached". **Captures still save; naming waits**, and resumes when AI
does. Whoever set the cap gets **Resume now**, to raise it, remove it or keep paused. A provider's
own rate limit is not a pause: progress lines say "Waiting for Groq · about 20 s" and carry on.

## What is sent to the provider

Kept's own summary, shown beside each provider:

> Only a copy of the photo with location and camera data removed, never the original. The fixed
> instructions and your location's languages. For the assistant, your question and the inventory
> it looks up, within your role. Never secret fields.

Under it, Kept summarises what the provider says it does with API data (training, retention) and
links its policy. A server you run yourself keeps what you let it keep.

## Search and embeddings

Keyword search always works, including the search words AI adds to things in each of the
location's languages. Search by meaning needs an embeddings model, which comes from one of three
places, set by the server's admin with `KEPT_EMBEDDINGS`
([configuration](/reference/configuration/)):

- `provider` (the default): the location's provider, when it has an embeddings model (OpenAI,
  Google, or an OpenAI-compatible server). Groq, Anthropic and OpenRouter don't, so with those,
  search stays keyword only and says so.
- `local`: a small model inside Kept, with no key and no per-call cost. Kept refuses this setting
  unless the local model's runtime is installed.
- `off`: keyword search only.

## Local models with Ollama

To keep everything on your own hardware, run a model with Ollama and add it as an
**OpenAI-compatible** provider with its base URL; Kept fills in nothing for this kind, so you name
the models. An address on your private network has to be allowed by an instance admin in Admin →
Settings first. Setup, memory and the Compose profile: [Ollama](/admin/ollama/).

## Turning AI off

- **For one location:** **Location settings → What to track**, under **AI in this location**,
  switch off **AI capture and the assistant**. Capture still works; things wait in the Inbox for a
  name.
- **For a while:** **Pause AI**, under Advanced.
- **Not connecting at all:** with no key at any level nothing is sent, and the checklist's
  **Connect an AI provider** step can be ignored.

The AI page has no button to delete a saved key; replace it, pause, or turn AI off per location.

:::note[ChatGPT or Claude as a client]
"Connect ChatGPT or Claude" (the Complete preset) works the other way round: your AI app reads
and updates Kept over MCP, using its own model and subscription, with a token you make in
**Settings → Connections**. See [connecting AI apps](/users/mcp-clients/) and, for the details, [MCP](/developers/mcp/).
:::
