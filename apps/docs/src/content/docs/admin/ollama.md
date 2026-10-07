---
title: Local AI with Ollama
description: Run the AI model on your own machine with Compose's Ollama profile, and what it costs in memory.
sidebar:
  order: 10
---

Kept's AI features (filling things in from photos and receipts, the assistant, semantic search)
work with whichever provider a location's owner connects in **Settings → AI**. Ollama runs the model
on your own hardware, so nothing leaves it; Kept talks to it as an **OpenAI-compatible** provider.

:::caution[Needs more than the floor]
Ollama on the [2 GB floor](/install/hardware/) hasn't been measured yet. Until it is, plan for a
machine with more memory than Kept alone needs, and expect a small model to be slower and less
accurate than a hosted one at reading receipts.
:::

## Setting it up

1. Start Kept with the `ollama` profile, then pull a model into it with Ollama's own command:

   ```sh
   docker compose --profile ollama up -d
   docker compose exec ollama ollama pull <model>
   ```

   The models live in the `ollama` volume. Nothing is published on the host: only Kept, on
   Compose's network, reaches Ollama. The image is about 3.8 GB (amd64) or 2.8 GB (arm64) before
   any model.

2. In **Settings → AI**, add an **OpenAI-compatible** provider with the base URL
   `http://ollama:11434/v1` and the model you pulled. Ollama ignores the API key, so any value
   does.
