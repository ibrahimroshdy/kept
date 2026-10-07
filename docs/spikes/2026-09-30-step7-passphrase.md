# Step 7, Task 0: the passphrase KDF (P1)

Run on 2026-09-30 on the laptop (Apple M1 Pro: 8 performance and 2 efficiency cores, Node
24.21.0). Plan: [step 7](../plans/2026-09-30-step-7-portability.md), Task 0 and Q7.

**Result: the pass line (under 1 s on the slower-core proxy) was not met reliably at N = 2^16,
but the runs were heavily contended. Decision (the coordinator's, 2026-09-30): keep N = 2^16, store the
parameters in each export's manifest, and let the V5 run on a real 2 GB, 2-vCPU VM decide, with
N = 2^15 as the fallback.**

## How

`docs/spikes/code/step7/p1_scrypt.mjs`: `crypto.scrypt(passphrase, 16 random bytes, 32,
{N, r: 8, p: 1, maxmem: 256 × N × r})` (Node refuses unless `maxmem` exceeds `128 × N × r`),
seven runs per N, median and maximum, peak RSS. Run with `--max-old-space-size=512`.

- **Laptop:** `node p1_scrypt.mjs`.
- **The slower-core proxy:** `taskpolicy -b node p1_scrypt.mjs`, which puts the process on the
  efficiency cores, as `bench:pi-speed` does for node (`apps/server/package.json`;
  [step-3 perf](../perf/2026-09-30-step3.md)).
- **Load:** other agents were running builds, tests and browsers the whole time; the load average
  was 24–28 on 10 cores. The efficiency cores are shared by every background process, so the
  proxy measured contention as much as speed.

## Results (ms)

| N (memory) | Laptop, median / max | Proxy run 1 | Proxy run 2 | Proxy run 3 |
|---|---|---|---|---|
| 2^13 (8 MiB) | 31 / 55 | — | 159 / 445 | 61 / 162 |
| 2^14 (16 MiB) | 39 / 45 | 573 / 1,243 | 355 / 1,284 | 115 / 124 |
| 2^15 (32 MiB) | 77–89 / 189–330 | 1,456 / 11,573 | 1,405 / 3,513 | 245 / 263 |
| **2^16 (64 MiB)** | **155–229** / 161–919 | 2,103 / 9,329 | 1,570 / 2,632 | **460 / 845** |
| 2^17 (128 MiB) | 432 / 561 | 8,601 / 13,381 | — | — |

Peak RSS at 2^16: 127 MiB on the laptop, 79 MiB on the proxy (scrypt's 64 MiB is outside V8's
heap, so `--max-old-space-size` doesn't bound it).

Read strictly, only 2^13 was under 1 s in every proxy run. That is 8 MiB, a large step down for a
key an attacker can attack offline for as long as they hold the ZIP. The one quiet proxy run put
2^16 at 460 ms median and 845 ms worst. So the evidence is about the contended machine, not about
scrypt, and the decision goes to the real VM.

## Decided

- **`N = 2^16, r = 8, p = 1`** (64 MiB), `maxmem = 256 × N × r` (128 MiB), a 16-byte random salt,
  a 32-byte key. For T1's `portability.ts`:
  `PASSPHRASE_KDF = {name: 'scrypt', N: 65536, r: 8, p: 1, keyBytes: 32, saltBytes: 16}`.
- **The parameters travel with the export.** The manifest's secrets block records
  `{kdf: 'scrypt', N, r, p, salt}` (base64url salt), and the importer derives with what the
  manifest says (within sane bounds: N a power of two from 2^14 to 2^20, r 8, p 1; anything else
  is `archive_invalid`). Changing the default later never breaks an old export.
- **V5 decides** (device checklist): if 2^16 takes over 1 s on the 2 GB, 2-vCPU VM, the default
  becomes 2^15 (32 MiB); old exports still open because of the manifest.
- It runs once per export or import request (and once per wrong-passphrase try, which Q7 already
  limits to 10 an hour per run), never per page. Two at once cost 128 MiB for well under a second
  on the laptop; T12's "one running export per location" and "5 an hour per person" keep it rare.
