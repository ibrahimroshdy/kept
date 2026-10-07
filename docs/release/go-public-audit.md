# Going public: the audit

Written 2026-10-07, at `main` = `6a73714` (852 commits, 63 of them not yet on `origin/main`).
An audit only: nothing here was changed, rewritten, pushed or switched on. Every finding has one
class:

- **Must fix before public**: do it (or have it done) before the visibility flip.
- **Decide**: the maintainer's call; the row says which way the audit leans.
- **Fine**: checked, nothing to do.

This file goes public with the repository, so it never repeats a value it asks to remove: where a
finding is an address, a name or a login, the row gives its file and line and describes it.

| Class | Count |
|---|---|
| Must fix before public | 11 |
| Decide | 17 |
| Fine | 35 |

## 1. Secrets in the whole history

**Scanner:** gitleaks 8.30.1 (`releases/latest` of gitleaks/gitleaks, read 2026-10-07),
`gitleaks_8.30.1_darwin_arm64.tar.gz`, SHA-256 `b40ab0ae…a9aeb6a5`, matching the release's
`gitleaks_8.30.1_checksums.txt`; run from `.tmp/` as
`gitleaks git --redact --log-opts=--all .` over every commit of every ref (it reports 851
commits scanned, ~67.6 MB).

**Pattern sweep:** every added line of `git log --all -p` searched for `gsk_`, `sk-`, `sk-ant-`,
`sk-or-`, `AIza`, `gh[pousr]_`, `github_pat_`, `-----BEGIN … PRIVATE KEY-----`,
`AGE-SECRET-KEY-1`, `age1…` recipients, SOPS (`sops:`, `ENC[AES256_GCM`), cosign/Sigstore key
headers, kubeconfig fields (`client-key-data`, `certificate-authority-data`, `kind: Config`),
`AKIA…`, Slack `xox?-`, JWTs and `password|secret|token = '…'` assignments. Separately, the two
values in the git-ignored `.env` were searched for as literals in every added line of every
commit, without printing them.

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 1.1 | The real `.env` values (`KEPT_DEV_OPENROUTER_API_KEY`, `KEPT_DEV_GROQ_API_KEY`) appear in **no commit** | all history | Fine | None. The names alone appear in spike code and `apps/server/src/ai/real-providers.test.ts`, read from the environment. |
| 1.2 | gitleaks: 8 findings, **all test fixtures**: a `'b'.repeat(70)` OpenSSH key body, a fake Wi-Fi password, `gsk_live0000secretWXYZ`, `test-key-TESTKEYMARKER…`, a label-stock key (`letter_30_67x25`), two mock invite/magic tokens | `0e6fac2c` recovery-kit-content.test.ts:39; `e33f5a45` embeddings.test.ts:43; `e2af7353` ai-settings.test.tsx:55; `ddd25706` test/ai-kit.ts:78; `4763af05` label-stocks.ts:66; `4c190529` mock/fixtures.ts:67–68, mock/server.ts:247 | Fine | Optional: a `.gitleaks.toml` allowlisting these paths, so a hosted scan (or GitHub secret scanning) starts green. |
| 1.3 | API-key shapes (`gsk_`, `sk-`, `sk-ant-`, `AIza`, `ghp_`, `github_pat_`), age keys, SOPS, kubeconfigs, Slack, JWTs: **0 added lines** | all history | Fine | — |
| 1.4 | Private-key headers: 6 lines, all placeholders (`abc`, `'b'.repeat(70)`, a truncated base64 stub, design-board text "pasted, 411 characters") | settings.test.ts:23, recovery-kit-content.test.ts:39, ops.test.ts:17, kept-screens.html:6547, screens/09-operations.html:72 | Fine | — |
| 1.5 | `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI…EXAMPLEKEY` | recovery-kit-source.test.ts, admin/recovery-kit.test.ts | Fine | AWS's own documentation example pair. |
| 1.6 | Password/secret assignments: 56 lines, every one a test value (`hunter2-…`, `kept-seed-password`, `spike-only-…`, `whsec_test`, `owner_pw`/`system_pw` psql variables) | 30 files | Fine | — |
| 1.7 | Files ever added whose name says `.env`/key/secret: only `.env.example`, `compose.env.example`, and source files about secrets (`secrets/*.ts`, `crypto/keyring.ts`, migrations 0019/0020/0028/0029/0031) | `git log --all --diff-filter=A` | Fine | `.gitignore` covers `.env*`, `*.pem`, `*.key`, `*.p12`, `*.sig`, recovery kits. |
| 1.8 | cosign: only the word, in scripts, runbook and workflow; no key material, no `cosign.pub` yet | release.yml, scripts/release*, docs/runbooks/release.md | Fine | `cosign.pub` is committed with the first release (runbook M1). |

**Conclusion: no secret was ever committed. No history rewrite is needed for secrets.**

## 2. Personal and private data

Swept at HEAD (`git ls-files`) and over every added line in history.

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 2.1 | Two addresses from the maintainer's own network in the SSRF test table: his homelab ingress's LAN address and a Tailscale (CGNAT) address of one of his machines | `apps/server/src/net/ssrf.test.ts:31–32` (since `eef8d96`) | **Must fix** | Replace with documentation-style values that test the same ranges, e.g. `192.168.1.21` and `100.64.1.1`. Neither is reachable from the internet, so history can keep them (see 2.12). |
| 2.2 | An absolute scratch path: an AI coding tool's temp directory, which spells out the maintainer's username and the name of another private repository | `docs/audits/ui-2026-09-29.md:26` (and the deleted `apps/web/.tmp-explore.mjs`, `f0f9bf2`) | **Must fix** | "the session scratchpad, outside the repository". Then widen `scripts/check-no-local-paths.mjs` (its pattern is `/Users/<x>/`, `/home/<x>/`, `C:\Users\`): add `/private/tmp/`, `/var/folders/` and the dashed form `-Users-<name>-`, which it missed here. |
| 2.3 | The perf record names the apps open on the maintainer's desktop (an AI assistant and a work chat app among them) and his private phone instance's port and database name | `docs/perf/2026-09-30-step3.md:27` | **Must fix** | "The machine was not idle (the maintainer's desktop session, the Docker VM and one light Kept instance)". |
| 2.4 | The maintainer's **work** GitHub login, in a `gh auth switch` instruction; line 74 above it mentions "the maintainer's orchestrator" | `docs/plans/2026-09-26-step-1-foundation.md:74–75` | **Must fix** | Drop both lines (they are about the private phase). |
| 2.5 | "switch back to the work account afterwards", and the signing key's location on the laptop (`~/kept-signing/cosign.key`) | `docs/runbooks/release.md:141, 152–153`, 1.0-checklist 7.5 | Decide | Lean: drop "switch back to the work account"; keep the key path as an example (`<path to cosign.key>`). |
| 2.6 | Four of the maintainer's private projects named, with their stacks, incidents and figures (a whole document of them) | `docs/research/2026-09-25-lessons-from-our-apps.md` (37–67 mentions each) | Decide | Lean: keep the lessons, replace each bracketed source with "[a previous app]" and drop the opening paragraph's names, or move the file out of the public repo. |
| 2.7 | The same projects named in code comments and specs, one with a version number | `apps/web/index.html:92`, `apps/web/src/styles/index.css:246`, `apps/web/src/components/pull-to-refresh.tsx:10`, `pull-to-refresh.test.tsx:2`, `docs/specs/2026-09-25-kept-engineering-spec.md:803`, product-design D15/D212, `docs/plans/step-8-done.md:38`, `docs/release/1.0-checklist.md:34` | Decide | Lean: genericise in the same pass as 2.6 ("an earlier app's fix"). Harmless if left. |
| 2.8 | "the maintainer's homelab" as the alpha's deploy target | `docs/specs/00-master-plan.md:562` | Fine | A word, no host or address. |
| 2.9 | Tailscale / tailnet / `.ts.net`: 49 lines, all generic how-to text (README, docs site, checklist, i18n catalogues). No tailnet or machine name anywhere in history | 22 files | Fine | — |
| 2.10 | LAN-style addresses: apart from 2.1, every one is an RFC 1918 example (`10.0.0.5`, `192.168.1.20`, …) or Compose's own subnet (`172.29.72.0/24`) | 31 files | Fine | — |
| 2.11 | Absolute paths at HEAD: none (`node scripts/check-no-local-paths.mjs` passes) | — | Fine | — |
| 2.12 | **History only**: absolute home-directory paths in 3 files (`334e9ad` step-3 plan, `a2b6307` step-2 plan, `cb48514` `apps/server/bench/_repro.mts`, removed in `0f6139b`); a committed `__pycache__/hb_client.cpython-311.pyc` holding an absolute path (`4c154b2`, deleted later); 2.1, 2.2 and 2.4's values in their original commits | history | Decide | They name only the username, which is also the public GitHub handle. Not worth a rewrite on their own; see 2.13 for the one that might be. |
| 2.13 | **History only**: the sample cast before the rename (eight first names the cast rule now bans, with family relations between them, in 74 files from 2026-09-26 to the renames `f45eec2`, `a4a638e`, `4c4d6c9`, `0a92b40`, `6015a3a`, `7448c3a`), plus a display name with the maintainer's surname (`b933c69` reports.test.ts), a "<surname> household" and a Cairo district as the PDF spike's account and location (`9703576` docs/spikes/code/pdf/lib/data.mjs) | history | **Decide (the key one)** | If those names are real family members (the ban suggests so; **inferred**, not known), the history has to change before it is public; see "History rewrite" below. If they are invented, nothing to do. |
| 2.14 | A banned cast name still at HEAD, in a normalisation test vector | `packages/shared/src/normalize.vectors.json:145` | Decide | Lean: swap for a cast name with the same Arabic shaping case (e.g. Alfred/ألفريد), keeping the vector's purpose. |
| 2.15 | Cairo place names in fixtures and boards (vendors and addresses such as Nasr City, Heliopolis, Dokki, Maadi); an invented phone number printed on the synthetic receipt | registries.test.ts:383, registries.test.tsx:494, kept-screens.html:4087/4175/4301, `apps/server/test/fixtures/eval/generate.mjs:27` | Decide | Fine unless one of them is the maintainer's real address; only he can tell. |
| 2.16 | The maintainer's first name as the sample owner; `ibrahimroshdy` in `ghcr.io/…`, `github.com/…`, the CLA allowlist and `gh auth switch --user` | cast.ts, charts, Dockerfile:206, cla.yml:43, runbook | Fine | His public GitHub identity, by his choice (D109). |
| 2.17 | Personal email, phone, home address, employer name: **0 hits** at HEAD and in history (emails found are `example.org`/`kept.test`; no Egyptian mobile pattern; the employer's name appears nowhere) | — | Fine | — |
| 2.18 | Images and documents: all 57 binary blobs ever committed checked. Eval and e2e photos are generated (`apps/server/test/fixtures/eval/generate.mjs`, `docs/spikes/code/step3/server/make-images.ts`), no camera EXIF; the one GPS tag is a deliberate 8×4 fixture (`apps/server/test/fixtures/files/photo.jpg`, Make "Kept", Model "Fixture", generic central-Cairo coordinates); the HEIC/MP4 files are 24–468-byte headers; the Homebox ZIPs are synthetic with the sample cast (their README says so; no email, URL or path inside but `example.com`) | fixtures, spikes | Fine | — |
| 2.19 | `docs/.DS_Store` in the first commit (`9aa8515`, removed in `40b5dad`): holds only the folder name `specs` | history | Fine | — |

## 3. AI attribution in history

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 3.1 | Commit messages, authors and committers: **clean**. `bash scripts/check-attribution.sh --range HEAD` passes over all 852 commits; a wider search of every message for co-author trailers, "Generated with", assistant and vendor names found only Kept's own AI feature ("AI capture", "Connect AI") | all commits | Fine | — |
| 3.2 | Every implementation plan opens with a line addressed to agentic workers that names an agent skill to use | line 3 of the eight `docs/plans/2026-0*-step-*.md` | **Must fix** | Delete the line. D173 bans naming an AI tool in commits, PRs and release notes; this is the same thing in the docs. |
| 3.3 | "The coordinator" (its rules, its notes, its list) in 15 files, and "the session scratchpad" | e.g. `docs/plans/step-6-done.md:3`, `docs/spikes/2026-09-30-step7-passphrase.md:7`, `apps/server/src/tokens/service.ts:279`, `docs/audits/ui-step4-2026-09-30.md:74` | Decide | Lean: leave; "the coordinator" reads as a role. Reword the one in source code (`tokens/service.ts:279`) to "the step-6 rule". |
| 3.4 | The product's own AI-provider and connector names (provider list, model ids, consent-page tests, design-board MCP frames, `models-openrouter-2026-09-26.json`) | 146 files | Fine | Product content, not attribution. |

## 4. Content that may not belong in a public repository

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 4.1 | Planning record: 22 plan/carry-over/done files (1.2 MB), 4 specs incl. the master plan (460 KB), 5 audits, 5 perf records, 6 eval reports, 3 research notes, the 1.0 checklist | `docs/` | Decide | Lean: **keep** (it is the design rationale the D-numbers in code point to, and it is honest about status), after 2.2–2.7 and 3.2. The alternative, a private `kept-internal` repository, breaks every `D…`/plan link in code comments. |
| 4.2 | Spikes: 257 files, 5.2 MB, incl. throwaway code, raw provider model lists and PNG/PDF results | `docs/spikes/` | Decide | Lean: keep the write-ups; consider dropping `docs/spikes/code/**/results/` binaries and the provider model-list dumps (third-party API output, dated, ~large) in a later cleanup. |
| 4.3 | The security audit lists 19 lows "left" and 5 schema items "queued", with their mechanics | `docs/audits/security-step6-2026-10-06.md:10, 103–…` | Decide | Lean: publish (no release is deployed anywhere but the maintainer's), but first confirm the 5 queued schema items landed and say so in the file. |
| 4.4 | Design boards: hand-made inline SVG symbols (`#a1-*`, `#k-*`, no third-party icon set copied in, **inferred** from their ids and the absence of any licence header), fonts from Google Fonts by link (IBM Plex, OFL) | `docs/design/` | Fine | — |
| 4.5 | Fonts and icons in the app: npm dependencies (`@fontsource/ibm-plex-*` 5.3.0, `@tabler/icons-react`, `lucide-react`), not vendored; covered by `scripts/check-licences.mjs` and the image's third-party notices | apps/web, apps/docs package.json | Fine | — |
| 4.6 | Homebox fixtures: Kept's own synthetic exports, made with a throwaway Homebox; no Homebox source copied | `apps/server/test/fixtures/homebox/` | Fine | — |
| 4.7 | Contributor Covenant 3.0 verbatim, with its CC BY-SA 4.0 attribution section | `CODE_OF_CONDUCT.md` | Fine | — |
| 4.8 | Agent instructions (`CLAUDE.md`, `AGENTS.md`, `.claude/`, editor rule files): **none tracked**; `.tmp/` (coordinator notes, agent rules) is git-ignored and never committed | — | Fine | — |
| 4.9 | Provider data-use summaries quote each provider's published terms, short and attributed with a URL | `apps/web/src/components/ai/data-use-note.tsx` | Fine | — |

## 5. Public-repository readiness

State read on 2026-10-07 with `gh api` (read-only): private; description, homepage and topics
empty; Discussions off; wiki and projects on; no branch protection, no rulesets; Pages not set
up; private vulnerability reporting off; no Actions secrets; no tags, no releases; no GHCR
package `kept` or `charts/kept` yet; default workflow permissions read-only; no webhooks or
deploy keys; two Actions runs, both `ci` and `docs` on a push, both **skipped** by their
`private == false` gate.

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 5.1 | `SECURITY.md` has the `[MAINTAINER STEP: the security contact address …]` placeholder, and points to private vulnerability reporting, which is off | `SECURITY.md:18–21` | **Must fix** | Maintainer: a real address; switch on private vulnerability reporting right after the flip. |
| 5.2 | `CODE_OF_CONDUCT.md` reporting contact is a placeholder | `CODE_OF_CONDUCT.md:54` | **Must fix** | Maintainer: an address. |
| 5.3 | `CLA.md` is a placeholder and says "the repository is private"; `cla.yml` switches itself on at the flip and will point every first-time contributor at that placeholder | `CLA.md:3–9`, `.github/workflows/cla.yml:26–27` | **Must fix** | Either generate the Harmony CLA (only the maintainer can) before the flip, or disable the `cla` workflow until then and say in CONTRIBUTING that pull requests wait for it. Lean: generate it first. |
| 5.4 | README says "There is no hosted CI" (false once `ci.yml` runs), has no status line for visitors, no install pointer for self-hosters (it is a developer README), no link to the docs site, no badges or screenshots | `README.md:10–18, 126–132` | **Must fix** (text) / Decide (screenshots, badges) | A one-paragraph "Status: pre-release, no release yet" and "Install: the docs site" at the top; the CI section rewritten. Screenshots from the seeded demo are worth it; a licence badge and a CI badge are cheap. |
| 5.5 | `LICENSE`: the full AGPL-3.0 text (661 lines); GitHub detects `AGPL-3.0`; the chart says `AGPL-3.0-only` | root | Fine | Decide: add `"license": "AGPL-3.0-only"` to the six `package.json` files (all `"private": true`, none has one). |
| 5.6 | `CONTRIBUTING.md`, issue templates (bug, idea), PR template: present, no placeholder | `.github/` | Fine | Decide: add `.github/ISSUE_TEMPLATE/config.yml` (`blank_issues_enabled: false`, contact links to Security advisories and Discussions). |
| 5.7 | `CHANGELOG.md`: absent; `scripts/changelog.mjs` makes it, and `release.sh` uses a committed section when there is one | — | Decide | See §7. |
| 5.8 | `ci.yml` once public: runs `ci-local.sh --fast` (lint, catalogues, typecheck, unit tests without a database, the mock eval) and the licence check on every push to `main` and every PR, and the attribution check on PR commits and body. All actions SHA-pinned; `persist-credentials: false`; read-only token | `.github/workflows/ci.yml` | Fine (keep on) | Decide: GitHub-hosted runners cost nothing on a public repository, so add a second job for what `--fast` skips: Postgres + pgvector as a `services:` container (the image ci-local already pins), the integration tests, migration drift, the leak test. It turns the gate's database half into a PR check. |
| 5.9 | `docs.yml` once public: builds the site on PRs (link check) and deploys to Pages on `main` | `.github/workflows/docs.yml` | Fine | Maintainer: Settings → Pages → Source "GitHub Actions" before the first push after the flip, or the deploy job fails. |
| 5.10 | `release.yml`: tag-only, no `private` gate; signs into the public transparency log by itself once public (`KEPT_RELEASE_TLOG`); its preflight refuses without `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` and a committed `cosign.pub`; header comments say minutes are billed | `.github/workflows/release.yml:1–18, 73–82, 145` | Fine | Decide: once public the `ubuntu-24.04-arm` runner should be free too (**inferred** from GitHub's public-repository runner terms; confirm on the billing page), so the header comments about billing can go and the release can move off the laptop for good. |
| 5.11 | Branch protection on `main`: none | GitHub | **Must fix** | Maintainer: a ruleset on `main` blocking deletion and force-push, `ci / fast` required for PRs, with a bypass for the maintainer (agents and the maintainer commit to `main` directly). |
| 5.12 | Secret scanning and push protection; Dependabot alerts | GitHub (`security_and_analysis` is null while private) | **Must fix** (verify) | Maintainer, after the flip: confirm secret scanning and push protection are on (GitHub defaults them on for public repositories, **inferred**; check the Security settings page), turn on Dependabot **alerts**, leave Dependabot security *updates* off (Renovate opens the PRs; its vulnerability alerts read Dependabot's). |
| 5.13 | Renovate: `renovate.json` (`config:best-practices`, Better Auth grouped, no Postgres majors, docs toolchain grouped) is inert until the app is installed | root | Decide | Maintainer: install the app after the flip; add its bot login to the CLA allowlist (checklist 6.7). |
| 5.14 | GHCR packages: do not exist yet; the first release run creates them private | — | Fine | Maintainer: make `kept` and `charts/kept` public after the first release run (checklist 7.10), or users get 401 on pull. |
| 5.15 | Repository metadata: no description, homepage or topics; wiki and projects on | GitHub | Decide | Description: README's first sentence, shortened. Homepage: the Pages URL once it exists. Topics: e.g. `self-hosted`, `home-inventory`, `inventory`, `pwa`, `mcp`, `fastify`, `react`, `postgres`, `agpl`. Wiki and projects off (the docs site is the documentation); Discussions on (D88, checklist 6.10). |

## 6. Commit history hygiene

| # | Finding | Where | Class | Fix |
|---|---|---|---|---|
| 6.1 | One identity for every author and committer: `Ibrahim Roshdy <22573766+ibrahimroshdy@users.noreply.github.com>`, 852/852 | `git log --format='%an <%ae>'` and `%cn <%ce>` | Fine | — |
| 6.2 | Size: 14.4 MiB packed (14,157 objects). Largest blobs are text: `docs/design/kept-screens.html` (842 KB) and the Arabic catalogue (775 KB), each in many versions that delta well (≤ 217 KB on disk). Largest binary: the Homebox ZIP (135 KB) | `git rev-list --objects --all` | Fine | — |
| 6.3 | Binaries ever committed: 57 blobs (26 PNG, 19 JPEG, 7 PDF, 2 HEIC, 2 ZIP, 1 MP4), all small; the PNG/PDF spike results (`docs/spikes/code/pdf/results/`, `step5/*/results/`) are the only ones a clone doesn't need | history | Fine | See 4.2. |
| 6.4 | Commit dates all fall 2026-09-26 → 2026-10-07 in one time zone (+03:00) | — | Fine | — |
| 6.5 | 63 commits on local `main` not on `origin/main` | — | Fine | The flip publishes whatever is pushed; push them first (checklist 6.13), after any rewrite decided in 2.13. |

### History rewrite: what it would take (only if 2.13 says so)

Nothing in history is a secret, so the only reason to rewrite is 2.13 (and, while at it, 2.12).
**No rewrite was done.** If one is wanted, it has to happen before the flip:

- `git filter-repo` with `--replace-text` (the eight names → the current cast, the surname
  strings → cast surnames, the two addresses of 2.1) and `--invert-paths` for the `.pyc` and
  `apps/web/.tmp-explore.mjs`; then a force-push of `main` to the private remote.
- Every commit id changes. **205 distinct commit ids are cited inside tracked files** (plans,
  done files, the checklist, audits, a mock fixture); filter-repo rewrites ids in commit
  messages, not in file contents, so those citations need a second `--replace-text` pass built
  from filter-repo's `commit-map`.
- GitHub can keep serving a rewritten-away commit by its id until it is garbage-collected
  (**inferred** from GitHub's "removing sensitive data" documentation). The clean route is to
  push the rewritten history to a **new** private repository, check it, flip that one, and
  delete the old repository, rather than force-pushing and flipping the old one.
- The simpler alternative, one squashed "initial public commit", loses the history the specs
  cite and every commit-id citation; the audit does not recommend it.

## 7. What to tag first

**The commit messages are conventional enough.** 842 of 852 subjects parse as
`type(scope): subject` (feat 348, fix 189, docs 102, i18n 80, test 66, chore 24, build 9, perf 8,
refactor 6, style 3, ci 3, spike 3, wip 1); 10 do not (two "Implement code changes…", two
"Refactor…", "Kick", the first two commits, a giant step-3 squash subject, two `ci-local:` /
`docs,config:` prefixes). A sample run,
`node scripts/changelog.mjs --version 0.1.0 --to HEAD`, printed **737 entries in 756 lines**,
grouped correctly; but subjects are long (median 84 characters, 303 over 100, the longest 1,217),
so a whole-history first section is accurate and unreadable.

| # | Finding | Class | Fix |
|---|---|---|---|
| 7.1 | First version | Decide | Lean: **go public untagged** (CI and the docs site on), then tag **`v1.0.0-rc.1`** once checklist rows 1.3 and 1.4 (the release and release-candidate dry runs) pass. The rc is what runs on the 2 GB amd64 and arm64 VMs (row 1.5, the blocker), and it is where the string freeze starts (7.1); 1.0.0 follows when those pass. A `0.x` tag instead fits only if a public preview is wanted before the dry runs pass; both need the cosign secrets, because `release.yml`'s preflight refuses without them even for a version `version.mjs` lets go unsigned. |
| 7.2 | The first CHANGELOG section | Decide | Lean: a hand-written `## 1.0.0-rc.1` section (the eight steps in a dozen lines, linking the docs site), committed as `CHANGELOG.md` before the tag; `release.sh` uses a committed section as is (`scripts/release.sh:308–318`). From then on `changelog.mjs --from <last tag>` writes each section. |
| 7.3 | Future subject length | Decide | Lean: a soft limit (≈ 72 characters for the subject, detail in the body) in CONTRIBUTING, so generated sections stay readable. |

## The go-public plan, in order

**Agents can do (tracked-file edits, one small commit each, no push):**

1. Replace the two real addresses in `apps/server/src/net/ssrf.test.ts:31–32` (2.1).
2. Strip the scratch path in `docs/audits/ui-2026-09-29.md:26`, the desktop/phone-instance
   details in `docs/perf/2026-09-30-step3.md:27`, the work-account lines in
   `docs/plans/2026-09-26-step-1-foundation.md:74–75`, and "switch back to the work account" in
   the release runbook (2.2–2.5).
3. Delete line 3 (the agentic-workers line) of the eight step plans (3.2).
4. Widen `scripts/check-no-local-paths.mjs` to catch `/private/tmp/`, `/var/folders/` and
   `-Users-<name>-` (2.2), with a test.
5. Rewrite README's top (status, install pointer, docs link) and its CI section (5.4).
6. Once the maintainer decides 2.6/2.7, 2.14 and 3.3: genericise the private-project names and
   the cast-rule leftover.
7. Optional: `.gitleaks.toml` allowlist (1.2), `ISSUE_TEMPLATE/config.yml` (5.6), `license`
   fields (5.5), the CI integration job (5.8).

**Only the maintainer can do:**

8. Decide 2.13 (were the pre-rename names real people?). If yes, the rewrite in §6 comes
   **before** anything is pushed or flipped, ideally into a new repository.
9. Write the three contacts: `SECURITY.md` (5.1), `CODE_OF_CONDUCT.md` (5.2), and generate the
   Harmony CLA into `CLA.md` (5.3), or disable the `cla` workflow until it exists.
10. Push `main` (checklist 6.13).
11. Settings, before the flip: Pages source "GitHub Actions" (5.9); a ruleset on `main` (5.11);
    description, topics, wiki/projects off, Discussions on (5.15); create the `cla-signatures`
    branch (checklist 6.8).
12. Flip: `gh repo edit ibrahimroshdy/kept --visibility public --accept-visibility-change-consequences`
    (checklist 6.12).
13. Right after: private vulnerability reporting on (5.1); confirm secret scanning and push
    protection; Dependabot alerts on (5.12); install Renovate and add its login to the CLA
    allowlist (5.13); check that the first `ci` and `docs` runs pass.
14. Release: the cosign key pair and the two secrets, `cosign.pub` committed (checklist 7.5); the
    dry runs (1.3, 1.4); the hand-written changelog section (7.2); tag `v1.0.0-rc.1`; make the
    two GHCR packages public (5.14); the 2 GB VM runs (1.5); then `v1.0.0`.

## Fixed at HEAD

2026-10-07, at `25901e2`. Every fix is an edit at HEAD; **history was not rewritten**: the
maintainer confirmed the pre-rename sample names (2.13) were fictional, so history stays as it is
(2.12's and 2.13's values remain in old commits only).

| # | State | Commit | What changed |
|---|---|---|---|
| 2.1 | Fixed | `35b4e80` | The two network addresses replaced by examples that hit the same branches (a 192.168/16 address, two RFC 6598 addresses), plus rows for the three RFC 5737 documentation ranges. 35 tests pass. |
| 2.2 | Fixed | `6321197`, `3715833` | The scratch path is now "a `ui-audit/` folder in the session scratchpad, outside the repository". `check-no-local-paths` widened (below). |
| 2.3 | Fixed | `6321197` | The perf record says only "the maintainer's desktop session, the Docker VM and one light Kept instance"; the same private instance's port and database name also left the step-8 plan's rules and the step-8 done file. |
| 2.4 | Fixed | `6321197` | Both lines replaced by "Commit after every task; do not push." |
| 2.5 | Fixed (lean) | `6321197` | "Switch back to the work account" dropped from the runbook; the suggested key folder stays, as an example. |
| 3.2 | Fixed | `fd6e69f` | The agent-tool blockquote removed from the head of all eight step plans. |
| 5.1 | Text fixed; **maintainer** | `efb0120` | GitHub private vulnerability reporting is the one channel (the Security tab → Report a vulnerability); no email address. Switch it on right after the flip (checklist 6.4). |
| 5.2 | Fixed | `efb0120` | Conduct reports: a private report through the Security tab titled "Conduct report", or @ibrahimroshdy on GitHub; no email address. |
| 5.3 | Fixed | `fd67826` | **DCO instead of a CLA** (plan D5): `CLA.md` and `cla.yml` removed; CONTRIBUTING "Sign your commits (DCO)"; `scripts/check-dco.sh` (with tests) runs as the `dco` job of `ci.yml` on a pull request's commits, no third-party app. History has no sign-offs; the DCO applies from the first public pull request. D105 marked superseded; checklist 6.2/6.3/5.82 done, 6.7/6.8 dropped. |
| 5.4 | Text fixed; rest later | `b229bfe` | README and `ci-local.sh` no longer say there is no hosted CI. The status line, install pointer and docs link come with the README rewrite (plan §3). |
| 5.11 | **Open, maintainer** | — | The ruleset on `main` is a GitHub setting. |
| 5.12 | **Open, maintainer** | — | Verify secret scanning and push protection, turn on Dependabot alerts, after the flip. |
| 2.6, 2.7 | Fixed (lean) | `892358a`, `32dade7` | The lessons note keeps every lesson and drops the source-app names; code comments, specs, the checklist and the step-8 record say "another of the maintainer's apps" or similar. |
| 2.14 | Fixed (lean) | `dea30d7` | The hamza vector uses the sample owner's name (same alef-with-hamza case, no article prefix); JS and SQL twins pass. |
| 3.3 | Fixed (lean, code only) | `25901e2` | Three server comments cite the plan instead of the build's coordinator. The docs' "coordinator" mentions stay. |

**`scripts/check-no-local-paths.mjs` (`3715833`)** now also fails on: macOS temp paths
(`/private/tmp/<x>`, `/private/var/<x>`, `/var/folders/<x>/`) and `/tmp/claude-<uid>`; a home
path flattened into a directory name (`-Users-<name>-`); a real tailnet host (`<x>.ts.net`; the
`<machine>.<tailnet>.ts.net` placeholder passes); the maintainer's homelab host names and domain;
and private (RFC 1918) or shared (RFC 6598) IPv4 addresses outside tests, fixtures, mocks,
chart-testing values and a listed set of files that each give a reason. 13 tests; it would have
caught 2.2 and 2.1's addresses outside a test file. Later the same day, the homelab names left
the checker itself, which would have published them: it now reads a developer's own terms from a
git-ignored `.private-terms` file (or `KEPT_PRIVATE_TERMS`), and its public rules are generic.

**Re-scan of HEAD:**

- `node scripts/check-no-local-paths.mjs`: passes.
- gitleaks 8.30.1 (the binary verified in §1), `gitleaks dir --redact` over an export of HEAD
  (`git archive HEAD`, so no ignored or untracked file): 9 findings, the 8 test fixtures of 1.2
  (same files, lines moved) plus this file's row 1.2, which quotes those fixture values.
  `gitleaks git` over the 11 commits after the plan (`528d916..25901e2`): no leaks.
- `git grep` at HEAD, this file and the checker excluded: the two addresses, scratch and temp
  paths, the private instance's port and database, the desktop app list, the work login and "work
  account", the agent-skill line, `MAINTAINER STEP` placeholders, "no hosted CI", the private
  project names, the banned cast names, home directories, tailnet and homelab hosts, kubeconfig and
  SOPS fields: **0**. API-key shapes: 2, both prefix-detection test inputs
  (`packages/shared/src/ai.test.ts:38–39`). `CLA.md` / `cla.yml` / `cla-signatures`: 13, all in
  the step-8 plan and spikes (the record of what was built then) or in the records of this change.
