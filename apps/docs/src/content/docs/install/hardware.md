---
title: What it needs
description: The smallest machine Kept supports, and what makes it need more.
sidebar:
  order: 6
---

**The floor is any machine with 2 GB of RAM and 2 CPU cores, amd64 or arm64**, with an external AI
provider: a mini PC, a NAS, a small VM or a cheap VPS. Kept's images are built for both
architectures, so Docker on Apple Silicon and ARM cloud servers run them too.

A Raspberry Pi with 2 GB or more will probably work, but it is not a promise: Kept isn't tuned for
it, and no release is tested on one.

:::caution[Not yet measured on the floor itself]
Kept's performance targets are promised on this floor: 10,000 things in a location (50,000 in an
instance), search under 300 ms and a thing's page under 200 ms of server time at the 95th
percentile, under 400 MB of memory for the web app and worker together, and ready within 10 s of
a cold start. They have been measured on a laptop limited to the floor's size; the run on a real
2 GB, 2-core VM, once on amd64 and once on arm64, is still due.
:::

## What needs more

- **Local AI with Ollama.** A model running on the same machine shares its memory with Kept, and
  it hasn't been measured on the floor yet. Until it is, treat Ollama as something for a bigger
  machine; see
  [Ollama](/admin/ollama/).
- **Photos.** Kept resizes uploaded photos as they arrive. With under 3 GB of RAM it resizes one at
  a time, else two (`KEPT_IMAGE_CONCURRENCY` overrides it).
- **Disk.** The database is small; files are what grow. Leave room for backups on another disk, and
  Admin → Status warns, and admins are alerted, when a disk passes 85 % full.

## Postgres

Kept needs PostgreSQL 18 with pgvector. Compose runs the `pgvector/pgvector` image, pinned by
digest; for a provider's database see [managed Postgres](/install/managed-postgres/).
