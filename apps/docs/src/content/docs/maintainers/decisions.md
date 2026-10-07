---
title: The decision log and the docs folder
description: What D-numbers are, where decisions and their reasons live, how a new one is recorded, and a guided map of docs/.
---

Kept was specified before it was built, and every choice a future reader might question has a
number. When code, a comment or a commit cites `D187` or `Q14` or `L30`, this page says where to
look it up.

## The identifiers

| Prefix | What it is | Where it lives |
|---|---|---|
| `D<n>` | a **decision**: what was decided and why (D1–D220 on 2026-10-07) | the decision log in the [product design, §4](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md); the question it answered in the [master plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/00-master-plan.md) |
| `V<n>` | an **assumption**: something inferred rather than verified, with how and when it gets checked | the product design's §19, the register of assumptions (D145) |
| `L<n>` | a **lesson** carried from the maintainer's earlier self-hosted apps | [lessons](https://github.com/ibrahimroshdy/kept/blob/main/docs/research/2026-09-25-lessons-from-our-apps.md) |
| `Q<n>` | a question raised **inside one build step's plan**, answered there | that step's plan in [`docs/plans/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/plans) |
| `T<n>` | a **task** in a build step's plan | the same plan |

A `Q` or `T` number is only unique within its plan: "step 8 T17" and "plan Q14" mean the step-8
plan's.

## How a decision is recorded

The [master plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/00-master-plan.md)
drives the spec. It lists every question by area (product, domain, access, AI, operations,
security, release, community and so on), each with a status and, where one exists, a proposed
default. Its "How we use it" section sets the rules:

1. **A question is decided:** its status in the master plan becomes `✅ D<n>`, the next free number.
2. **The decision is written into the product design's decision log** as a row: the number, the
   decision, and **why**. The product design is the contract; nothing is built from the master plan
   directly.
3. **Who decided is marked.** `(delegated)` marks a decision made by delegation after the
   maintainer said to proceed without asking; the log's header says which ranges are delegated
   and which are his own. A row that refines an earlier decision says so (`refines D83`).
4. **A changed decision is superseded, not rewritten.** The old row keeps its text and gains a
   note naming what replaced it. D105 is the example: the CLA, superseded on 2026-10-07 by the
   go-public plan's D5, the DCO ([the DCO](/maintainers/dco/)).
5. **The master plan's session log** gets a row: the date, the areas covered, and the decisions
   made.

Other statuses in the master plan: `🟡` a proposed default awaiting confirmation, `⬜` open, `⏭`
deferred with a reason, `🔬` being verified by research, `⛔` blocked on the maintainer. A feature
enters scope only by an explicit decision (L106).

Release-time choices recorded outside the log, such as the
[go-public plan](https://github.com/ibrahimroshdy/kept/blob/main/docs/release/go-public-plan.md)'s
D1–D6, carry their own numbering inside that file; where one replaces a logged decision, the log's
row says so.

## A map of `docs/`

| Folder | What is in it |
|---|---|
| [`specs/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/specs) | The master plan; the **product design** (what Kept is, the decision log, scope, domain, access, the threat model, the register of assumptions); the **engineering spec** (data model, contracts, numbers and limits, and §7's foundations: database roles, RLS, keys, sync, auth, environment, CI); the **screens** spec |
| [`plans/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/plans) | One implementation plan per build step (`<date>-step-N-<name>.md`), with its tasks and questions; `step-N-done.md`, each item of the step's definition of done marked met or not with evidence; `step-N-carryover.md`, what was left open and where it goes |
| [`spikes/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/spikes) | Short experiments run before building something uncertain (a library, a device behaviour, the release pipeline), each with its result and what it feeds; `spikes/code/` holds their code |
| [`runbooks/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/runbooks) | Operational procedures with commands and a verification step: see [runbooks and scripts](/maintainers/runbooks/) |
| [`audits/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/audits) | Reviews: the step-6 security review and the UI reviews, each with findings by severity and what was fixed |
| [`release/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/release) | The 1.0 checklist, the go-public audit and the go-public plan |
| [`perf/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/perf) | Dated performance measurements: the RLS benchmark and each step's figures against the spec's targets (§3.1) |
| [`evals/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/evals) | Dated AI evaluation reports, per provider and model |
| [`research/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/research) | The landscape of other inventory apps, the lessons, the Homebox import research |
| [`design/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/design) | The design board and the screens board (HTML) and their sources |

## Where to start

- **Why does Kept do X?** Search the product design's decision log for the feature; the "Why"
  column has the reason.
- **How is X built?** The engineering spec, then the step plan that built it and its done-note.
- **Is X verified?** The register of assumptions (§19) and the spike that checked it.
- **Changing a decided behaviour?** Propose it as a new decision that refines or supersedes the
  old one, so the log keeps both.
