# Spike S6.5 (D207): the local embedding model

Date: 2026-09-30. Step-6 plan, Task 0, S6.5. **Result: FAIL on memory. Everything else passes or
nearly passes. `local` stays unavailable (D207)** until the memory is brought under the limit.

The container run was stopped when the host disk filled and Docker's VM disk failed. After the
outage, the coordinator's rules for the re-run were: no more image builds, a plain Node process,
and under 500 MB of new disk. So it was measured on the laptop (arm64, Node 24.21.0) as **one plain
Node process**, `--max-old-space-size=512`:
- Kept's web + worker (`KEPT_ROLE=all`) ran **from source under tsx**, so its RSS is an upper bound
  for the built image;
- the model was loaded the way T14 would, with `intraOpNumThreads: 2` (macOS has no cgroup, so the
  2-CPU floor is only the thread count, and the 2 GB limit wasn't enforced);
- the model came from the official hub repo at the pinned revision, and all four files' sha256s
  matched the manifest.

**Not measured:** amd64, and a real 2 GB / 2-vCPU VM (both are the device row), and the provider
comparison (no keys).

| Condition (plan) | Measured (arm64 laptop, plain Node) | |
|---|---|---|
| Added RSS with the model loaded ≤ 300 MB | **+418 MB** over idle (run 2; run 1 +377 MB). Importing the runtime alone adds +179 MB. Peak while loading is 794 MB | **FAIL** |
| Idle web + worker < 400 MB, model unloaded | 189 MB RSS (from source under tsx; an upper bound) | pass |
| First index of 10,000 things ≤ 30 min | 10,210 things in 158 s (run 1: 103 s), 65–99 things/s, batches of 32, 2 threads | pass (a real 2-vCPU VM will be slower, and the margin is ~10×) |
| Query embedding p95 ≤ 200 ms | p95 7.2 ms, p99 9.2 ms, max 28 ms (258 queries; run 1 p95 11.2 ms) | pass |
| recall@10 ≥ keyword-only + 0.10, Arabic | households (realistic): keyword 0.24, **semantic 0.67 (+0.43)**, RRF 0.69. bench (synthetic): keyword 0.15, semantic 0.20 (+0.05), **RRF 0.26 (+0.11)** | pass with RRF, which is what T14 ships (Q14); semantic alone misses on the synthetic bench set |
| Image growth ≤ 150 MB | pruned: ~56 MB arm64 (measured in the image before the outage), ~61 MB from this install's tree (linux/arm64 ORT 24 MB); unpruned 474 MB | pass **only if pruned** |
| Licences pass | not run through `scripts/check-licences.mjs` (it reads the pnpm workspace). The installed tree's own `license` fields: MIT, Apache-2.0, ISC, BSD-3-Clause, (MIT OR CC0-1.0), and libvips's LGPL-3.0-or-later, which Kept's sharp already carries | inferred pass |

**Memory doesn't come back on unload:** after `dispose()`, RSS fell from 606 MB only to 406 MB,
still +217 MB over idle.

**Where the memory goes (inferred from the phases):**
- importing `@huggingface/transformers` loads onnxruntime-node's native library, the bundle (which
  inlines ORT-web's JS) and **a second libvips**: npm resolved sharp 0.35.5 beside Kept's 0.35.4,
  and macOS warned that both `libvips-cpp` 8.18.6 and 8.18.7 were loaded;
- loading the q8 model and its 25 MB tokenizer adds about 240 MB more.

Code: `docs/spikes/code/step6/local-embeddings/`. It is throwaway and outside the workspace.
- `node-harness.ts`: the plain-Node run above. Its header says how to run it.
- `results-node-2026-09-30.json`: both runs, per-query scores included.
- `setup-db.ts`: the scratch database `kept_spike6_local` on 5452. It is created and seeded as
  `bench/rls.bench.ts` does (households, then bench with 10,000 things), and `--drop` removes it.
  It was dropped after the run.
- `Dockerfile` + `package.json` + `harness.mjs`: the container version (`FROM` a Kept image,
  `PRUNE=1`). Kept for the real-VM device row. **Don't build it on the laptop** (the outage).
- `model-granite97m.json`: the pinned model id, revision, files, sizes and sha256.
- `queries.json`: the **provisional** search set (see below).

The runtime (123 MB after removing other platforms' ORT binaries) and the model (123 MB) were
installed in the session scratchpad, not the repo, and deleted after the run. The npm install
replaced `onnxruntime-web` with an empty stub through `overrides`: the node build of transformers
imports only `onnxruntime-node` and `onnxruntime-common`, and bundles the web JS (read from
`dist/transformers.node.mjs`'s imports). Inference worked with the stub.

## Versions (checked with `npm view` on 2026-09-30)

| Package | Version | Licence | Unpacked |
|---|---|---|---|
| `@huggingface/transformers` | 4.3.0 (latest) | Apache-2.0 | 9.9 MB |
| `onnxruntime-node` | 1.30.0 (latest) | MIT | 301 MB: prebuilt binaries for darwin, win32 and linux, x64 and arm64 |
| `onnxruntime-web` | 1.31.0-dev.20260914-8d85527a0 (**a dev build, pinned exactly** by transformers 4.3.0) | MIT | 145 MB |
| `onnxruntime-common` | 1.30.0 (plus 1.31.0-dev.20260911-2a43ec07e under onnxruntime-web) | MIT | 0.6 MB |
| `@huggingface/tokenizers` | 0.2.0 | Apache-2.0 | 0.4 MB |
| `@huggingface/jinja` | 0.5.10 | MIT | 0.4 MB |
| `adm-zip` 0.6.1, `global-agent` 4.1.3 (onnxruntime-node's postinstall) | | MIT, BSD-3-Clause | small |
| `sharp` | `^0.35.4`: npm resolved **0.35.5**; Kept pins 0.35.4 | Apache-2.0 (libvips LGPL, already excepted) | |

The rest of the tree (read with `npm ls --all` in the container): `protobufjs` 7.6.6 and
`@protobufjs/*`, `flatbuffers` 25.9.23, `long` 5.3.2, `guid-typescript` 1.0.9, `platform` 1.3.6,
`@types/node` 26.6.3, `globalthis`, `matcher`, `serialize-error`, `type-fest` 0.20.2 and
`semver` 7.8.5.

`scripts/check-licences.mjs` **was not run** on the new tree. It needs `pnpm licenses list --prod`
on a workspace with the dependency added, and that install was the next step when Docker failed.
From `npm view`, every package listed above has a licence on `RUNTIME_ALLOWED`. That is inferred
from the registry metadata and is not the script's verdict.

## The model (candidate 1, smallest first)

Candidates were found through the runtime's own documentation. The transformers.js 4.3.0 README
says to find compatible models by the hub's `transformers.js` library tag and task. The hub API
query with that tag was
`https://huggingface.co/api/models?filter=transformers.js&pipeline_tag=feature-extraction` (and
`sentence-similarity`), sorted by downloads. Note that `library=transformers.js` is **not** a filter
on that API: it returned models without the tag.

Entries that were multilingual, tagged `ar`, and permissively licensed, smallest first:

| Model | Params | q8 ONNX | Dims | Licence (hub tag) |
|---|---|---|---|---|
| `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | 97M | 97.9 MB | 384 | apache-2.0 |
| `onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX` | 118M | 118.0 MB | 384 | apache-2.0 |
| `Xenova/multilingual-e5-small` | 118M | 118.3 MB | 384 | **no licence tag** on the conversion (base `intfloat/multilingual-e5-small` is MIT): skipped |

**Picked for the first run:** `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`.
- **Revision (commit sha):** `536a9f241cb3f02a9c5995a1e708c784bd274859` (2026-06-21).
- **Licence:** Apache-2.0, from the card and the hub tag. It is an automatic ONNX conversion of
  `ibm-granite/granite-embedding-97m-multilingual-r2`, which is Apache-2.0 and lists Arabic among
  its 52 "enhanced support" languages.
- **Architecture:** ModernBERT (transformers.js 4.3.0 maps `modernbert` → `ModernBertModel`).
- **Pooling:** CLS, from the base repo's `1_Pooling/config.json`. No query or passage prefix is
  shown on the card.
- `dtype: 'q8'` selects `onnx/model_quantized.onnx`. This was read from `DEFAULT_DTYPE_SUFFIX_MAPPING`
  in `transformers.node.mjs`.

| File (download from `https://huggingface.co/<id>/resolve/<revision>/<path>`) | Bytes | sha256 |
|---|---|---|
| `config.json` | 1,215 | `ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee` |
| `tokenizer.json` | 25,301,671 | `51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a` |
| `tokenizer_config.json` | 12,860 | `6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5` |
| `special_tokens_map.json` | 871 | `013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69` |
| `onnx/model_quantized.onnx` | 97,858,099 | `704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22` |

The LFS sha256s come from the hub API (`?blobs=true`, `siblings[].lfs.sha256`). The three small
files were fetched at the revision and hashed; their sizes match the API. The total download is
about 123 MB. **Not yet confirmed:** which of these files transformers.js actually fetches. The
harness records that list and re-hashes every file in the data volume.

Candidate 2, if granite fails, is `onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX` at
revision `d4c06bf0d7680171ac30042a1387e1fdb7a90021`, using `onnx/model_quantized.onnx` (118,049,319
bytes, sha256 `0029fce9c82365d8a2bf20e03a476e84785a872d8d423c8bac0fd0f350df88dc`) with mean pooling.
No manifest has been written for it yet.

## Image size (arm64; measured with `du` inside the built image)

The install was made on top of `kept:ci-arm64` (label revision `2f3f47a`, 615.2 MB).

| Tree | Size | vs ≤ 150 MB |
|---|---|---|
| As installed (`npm install --omit=dev --ignore-scripts`) | **474 MB** (484,892 KB): onnxruntime-node 288 MB, onnxruntime-web 141 MB, @img 19 MB, @huggingface 17 MB | ❌ |
| Pruned (`PRUNE=1`) | **56 MB** (57,644 KB): onnxruntime-node 25 MB (linux/arm64 only), @huggingface 17 MB, onnxruntime-web 5.2 MB (no dist/), protobufjs 3.2 MB, @types 2.7 MB | ✅ (arm64; amd64's linux/x64 binaries are 45 MB, so about 76 MB, inferred) |

- **The image deltas from `docker history` are not valid.** The first builds left npm's cache in the
  layer (the image's `HOME` is `/tmp`, so the cache sat in `/tmp/.npm`): 666 MB raw, 229 MB pruned.
- The Dockerfile now uses `--cache` with a throwaway directory, but the corrected rebuild is the one
  that hit the I/O error.
- The pruned figure is therefore the node_modules `du`. The layer adds only metadata to that
  (inferred).

What pruning removes, and why it is safe:
- **onnxruntime-node binaries for other platforms:** darwin/arm64 86 MB, win32 x64 and arm64
  64 + 70 MB, and the other linux arch.
- **onnxruntime-web/dist:** 136 MB. `transformers.node.mjs` bundles the ORT web JS inline and loads
  `onnxruntime-node` with `requireFromHere` (read from the dist file).
- **The duplicate sharp:** in the workspace, pnpm would reuse Kept's copy if it dedupes `^0.35.4`
  to the pinned 0.35.4. That is **unverified**, and the pnpm install that would show it was not reached.

**Proven on the laptop:** inference works with onnxruntime-web replaced by an empty package and the
other platforms' ORT binaries removed (darwin/arm64 kept). A pruned linux image is still unrun.

## Method

As in the header, and as `harness.mjs` does it in a container. Keyword-only is **Kept's own
`search()`** (`apps/server/src/search/service.ts`, `kind: 'things'`, limit 50). It runs inside
`withScope` as the location's member (bench) or as Ibrahim (households), under RLS, so it includes
both tsqueries and the trigram door of 0030. Semantic is an exact cosine over the stored vectors,
top 50. RRF is k = 60 over the two lists. Locations are resolved by membership, not by name:
every user has a location called "Personal".

A harness bug to know about: the first run's checksum check matched `tokenizer_config.json`
against `config.json`'s hash (a suffix match). The file was re-fetched from the hub at the
revision and matched the manifest. Both harnesses now match whole path segments.

## The provisional search set (`queries.json`)

**This is provisional and is not T17's set.** It has two parts, 129 queries in total, written in
Egyptian Arabic and English by the spike author:
- **bench:** 34 Arabic + 34 English queries over the 10,000-thing 'Bench 10k' location (names from
  `seed/words.ts`). A thing is relevant when its noun is one of the query's concept nouns, in either
  language, so an Arabic query can find English-named things.
  - Caveat: the bench seed draws types and brands at random, so a thing's type often contradicts its
    name. Both keyword search and embeddings read the type.
- **households:** 31 Arabic + 30 English queries over the households seed's 60 realistic things, as
  Ibrahim. The expected things are named exactly.

Each query carries a `literal` or `meaning` label. Expectations are names or nouns, not ids, because
ids change on every seed. The metric is recall@10 = |relevant ∩ top 10| / min(10, |relevant|), plus
MRR@10. T17 grows or replaces this set.

## Provider comparison

Pending. There are no OpenAI or Google keys, so `text-embedding-3-small` and `gemini-embedding-001`
were not called.

## What changes in the plan

- **D207 / T14:** `local` stays unavailable in 1.0 **unless** the memory fits. The levers, in order,
  all untested:
  1. run the model in a **child process** the worker starts on demand and ends when idle. Its
     memory is then separate and returned in full, which also fixes "dispose gives back only
     half";
  2. dedupe `sharp` onto Kept's 0.35.4 (pnpm override), removing the second libvips;
  3. ORT session options (memory arena and pattern off);
  4. the second candidate, `onnx-community/paraphrase-multilingual-MiniLM-L12-v2-ONNX`.

  With (1), the 300 MB condition would read "the model process's RSS". The limit itself, and
  whether it counts against the 2 GB floor with the web and worker, is **the maintainer's call**.
  T14 builds `provider` and `off` now; `local` is a later task behind a re-run of this spike.
- **T2 (if `local` comes back):** prune onnxruntime-node's other-platform binaries and
  onnxruntime-web's `dist/` (or override it with an empty package, as here). transformers pins a dev
  build of onnxruntime-web. Force `sharp` to Kept's version.
- **T14 (when built):**
  - pin `revision` to the commit sha and verify the manifest's sha256s, matching whole paths;
  - set `intraOpNumThreads` from the allowed CPUs (cgroup `cpu.max`);
  - point `env.cacheDir` at `KEPT_EMBEDDINGS_DIR`.
- **T14 / Q14:** ship RRF, not semantic alone. On the synthetic Arabic set, semantic alone was only
  +0.05 over keyword; RRF was +0.11.
- **T17:** starts from `queries.json`. The households part is the meaningful one; the bench part's
  random types make it noisy.
- **Device row D207:** on a real 2 GB VM (amd64 and arm64), with the container harness, once the
  memory fix exists.
