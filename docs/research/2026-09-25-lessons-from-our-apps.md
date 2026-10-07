# Lessons from our previous apps

Kept's maintainer has built and run several other self-hosted apps (Fastify, Flask, Node and
SvelteKit back ends on Postgres or SQLite, PWAs, MCP servers and LLM features). Each lesson below
was learned the hard way in one of them, and names what it means for Kept.

## A. Data, dates, money

1. **Store instants, answer in local time.** A UTC day boundary put 101 records on the wrong day. → Each location has a timezone; "due today" is computed there.
2. **Date ranges are inclusive local dates.** `new Date("2025-10-01")` is UTC midnight and dropped the last day of every range. → Warranty and service dates are local calendar dates.
3. **One date helper; tests pin a non-UTC zone** so a UTC CI runner can't pass a wrong test.
4. **Quota days reset in the provider's zone**, not the user's.
5. **Money is numeric, never float.**
6. **Filtering by currency silently deletes data.** 12.7% of rows vanished from every chart. → Sum a converted column and report how many rows couldn't be converted.
7. **Never invent historical exchange rates from today's rate;** tag derived values with their provenance.
8. **Store events; derive intervals.** A missing half shows as "open", never a guessed value. → Store meter readings, derive distance and intervals.
9. **Pair events per device.** A global walk let one device close another's session. → Pair readings per thing *and* per meter.
10. **Unclosed intervals get a cap; beyond it the answer is "unknown".** → A stale reading makes a schedule "unknown — reading needed".
11. **Don't print a ratio while its denominator is still moving.**
12. **Compare like-for-like windows;** five days vs a full month invented an 81% drop.
13. **Reject impossible readings at ingest.** Corrupt zero bars produced phantom events. → Odometer going backwards is rejected; implausible jumps need confirmation.
14. **References, not free-text tags.** A tags table shipped with four seeded rows that no code ever applied. → People and Vendors are registries; "belongs to" is a reference.
15. **Every unique key leads with the tenant.**
16. **Seed data is a template copied per tenant.** → Built-in types are templates.
17. **IDs and slugs never move when a name changes.** Renaming would have silently broken queries addressed by slug. → Stable short IDs for things (QR labels).
18. **Check-then-insert races during rolling deploys.** Two pods both found nothing. → Every generator writes behind a unique constraint.
19. **Evidence is immutable; interpretation is editable.**
20. **Trust is per field, not per record.** Usually one field needs a human.
21. **Never invent a value; record unknown and surface it.**
22. **"Recurring" never generates future rows;** compute the next one.
23. **Every value shows its as-of time.** A five-week-old value read as today's.
24. **Proposed and applied are separate records,** each with provenance.

## B. Tenancy, auth, keys

25. **Enforce tenancy with Postgres RLS,** not WHERE clauses.
26. **A superuser bypasses RLS even with FORCE.** Two scoped connections read each other's rows. → Separate owner and app roles; the app refuses to start without its role.
27. **"No scope" must mean refuse.** A user with no membership was served the whole database.
28. **Views bypass RLS unless `security_invoker = true`.** A brand-new account saw another household's headline number. The spec had named the risk and argued it away without a test. → A schema-wide test fails on any unsafe view or unforced table.
29. **Hijacked replies and fire-and-forget work leak pooled connections.** The MCP route bypassed the release hook and exhausted the pool.
30. **Background jobs iterate tenants explicitly.**
31. **Don't copy tenancy UX from other tools without deciding it.** A workspace switcher shipped from one approved spec line nobody asked for, then was removed.
32. **Sign-up closed by default** on self-hosted installs.
33. **Forgot-password works without SMTP** (the link goes to the log); always answers 202; token stored hashed. *(Superseded by D188: without SMTP, reset goes through the `kept admin` CLI, and reset links are never written to logs.)*
34. **Rate-limit config can be a silent no-op.** A route flag shipped with no plugin registered. Key on the forwarded IP behind a proxy, and have a test prove the limit fires.
35. **API keys:** prefixed, shown once, hashed, scoped, revocable, bound to one tenant; `last_used_at` written at most once a minute.
36. **CLIs refuse to guess the tenant.**
37. **Identity comes from the key, never from a name in the payload.** A fallback auto-created an "Unnamed device".
38. **Export and delete read one shared table list,** tested against the catalogue so no new table is forgotten.
39. **Decide per table which data is global and which belongs to a tenant.**
40. **Audit every mutation centrally.** 45 endpoints could change data; 7 logged it.

## C. LLM integration

41. **The binding limit is tokens per minute,** per account, not per key. → Pace on estimated tokens.
42. **Reasoning models bill thinking against max output;** `output == cap` means a silently truncated answer. → Treat a length stop as failure; expose reasoning effort.
43. **Estimate tokens high;** Arabic measured about 2.4 characters per token.
44. **Turn SDK retries off;** hidden retries are uncounted requests.
45. **Quota exhaustion needs a circuit breaker.** A queue re-ran 99 jobs every 10 minutes against an empty quota.
46. **Interactive and background work get separate budgets.**
47. **Log every call** (prompt, reply, tokens, latency, finish reason) in a tenant-scoped table with a UI.
48. **Provider config is read per call from the DB;** keys encrypted, masked, never returned.
49. **Model lists go stale;** allow a free-text model name.
50. **Verify provider features by request, not memory.** For example, one provider can't combine structured output with streaming or tools.
51. **Models fabricate when asked to copy rows or links.** → Code renders IDs and links; the model only classifies and extracts. [n8n digest]
52. **Drop unsupported output** (unparseable fields, citations to nothing).
53. **Suggestions never write directly.**
54. **Gate review on consequence, not source;** rubber-stamp queues stop being read. → Auto-accept a name; confirm a price, a warranty date or a reading.
55. **Agent writes are proposals bound to a hash of their arguments,** with an expiry.
56. **Documents and tool results are data, never instructions.**
57. **Never let the model and the code enforce the same rule.**
58. **Re-asking until yes corrupts results.** Re-asked answers were right 20% of the time against 42% first pass. → An extraction re-run is explicit and replaces the draft.
59. **Blunt output style:** concrete figures, no hedging or filler.
60. **The model must not answer from memory** what the data or a document should answer.
61. **Keep an eval set with dated results and a mock provider for CI.**
62. **Show 429 waits honestly** (a countdown from `retry-after`).
63. **Tell users what each provider does with their data;** home photos are sensitive. *(inferred)*

## D. MCP

64. **Small tool lists choose better;** about 15 tools named after real questions, plus a capabilities tool.
65. **Thin tools call the app's own routes,** so validation, permissions and audit are never duplicated.
66. **Raw SQL is either guarded to the hilt or excluded.** It answered across all tenants once. → Excluded in Kept.
67. **Read scope implies all reads; the write scope only chooses which tools appear;** side-effects need confirmation; tools that spend AI budget say so.
68. **Read-only tokens don't even see write tools.**
69. **Stateless transport;** stateful sessions break on rolling deploys.
70. **Output conventions:**
    - Compact JSON with units in field names and `as_of` on every payload.
    - Paginated lists, 20 by default and at most 200.
    - Around 8 KB per response.
    - Errors as `{error, hint}`.
71. **Audit writes; log every call without argument values.**
72. **Some data never crosses MCP:** keys, secrets, hashes, push secrets; evidence fields are read-only.
73. **Teach the vocabulary at connect time** in the server instructions.

## E. Files, backups

74. **Resize on ingest, bake rotation, strip GPS;** plan for HEIC from phones.
75. **Keep originals of evidence** (receipts, proof photos); resize only decorative photos. *(inferred)*
76. **Alert on storage growth;** tenants need a quota on the cloud.
77. **Never hot-link assets;** ship icons or store them.
78. **A backup is proven only by a restore drill that compares data,** not row counts. One restore failed a table silently because an extension was missing.
79. **Refuse suspiciously small dumps; alert when a backup is stale;** a backup on the same disk is not a backup.
80. **Restore into a new database, verify, then swap;** snapshot before any destructive reset.
81. **A human-readable export** is both a backup and an anti-lock-in feature.
82. **Replays and offline uploads need stable idempotency keys.**
83. **Choose a pgvector-capable glibc Postgres image on day one.**

## F. Mobile, PWA, UI behaviour

84. **The page frame never scrolls;** a single inner element does. Otherwise fixed bars drift on iOS.
85. **Apply the theme before first paint;** the manifest `theme_color` must match the meta tag.
86. **Two iOS PWA bugs:** `black-translucent` leaves dead space at the bottom (use `default`), and iOS 26 blurs the header unless an opaque strip touches the edge.
87. **iOS eats taps two ways:** pull-to-refresh calling `preventDefault`, and WebKit's hover heuristic while the page is still receiving data. Keep an on-device diagnostics probe.
88. **House UI rules:**
    - **Width and density:** no horizontal scroll at 320 px; tables become row lists on phones; fewer columns, never fewer rows; **nothing truncated on a phone**.
    - **Touch:** 16 px inputs; touch targets of at least 40–44 px.
    - **Forms:** bottom sheets on phones; explicit Save, no autosave.
    - **No native select or confirm dialogs,** enforced by a grep test.
    - **Loading and errors:** skeletons; an error boundary per route; routes code-split with an entry-bundle weight test.
    - **Lists:** every list has search, filter, group and pagination, with state in the URL.
    - **Charts:** every number drills down to its rows; stacked charts must total the flat chart.
    - **Colour:** one meaning per colour; AI-extracted values get their own colour.
    - **Before calling a screen done:** check at 375, 768 and 1280 px in both themes.

## G. Testing & CI

89. **A green summary can hide exit code 1;** gate on the exit code.
90. **Config that exists only in production is untested;** run CI again with prod-only config set. Assert values, not just presence.
91. **Tests on their own database.** Tests truncated the dev database: 426 rows became 2.
92. **Test every wire format:** multipart and urlencoded uploads, and HEIC.
93. **Cross-endpoint consistency tests;** every route belongs in the smoke list.
94. **Health is a gauge read from data** ("last successful scan age"), not a counter.
95. **Schema-vs-migration drift check;** end-to-end tests retry once and report flakes.
96. **Some bugs only reproduce on a device;** keep an opt-in diagnostics toggle.

## H. Release & migrations

97. **Rolling updates remove deploy downtime,** which makes **additive-only migrations** mandatory: drops and renames take two releases. Add a startup probe and a short pre-stop sleep.
98. **Migrations apply only when dated after the last applied one;** watch branch merges and check ordering in CI.
99. **Migrations run once** (init container or pre-upgrade hook), never from every replica.
100. **Stamp version and SHA into the image and show them.** A bare build shipped "dev".
101. **Never publish a tag before its image exists.**
102. **Keep dependency layers stable and the app layer small;** no network I/O at import or boot.
103. **Publish multi-arch images and test both.**
104. **CI can silently stop** (billing blocked for five days); keep a laptop release path that mirrors CI.
105. **Schedules live in data, not in timers;** jobs are idempotent across overlapping pods.

## I. Scope discipline

106. **Approving a long spec is not requesting a feature;** decisions are asked explicitly.
107. **Every field has a reader and a writer,** or it isn't shipped.
108. **Don't abstract from one example.**
109. **Name things honestly:** "estimated next service", not "due".
110. **Judge a library against the real gaps before trying it.**
111. **Production-grade operations, modest feature surface.**

## J. Notifications

112. **Send per user with permission checks,** never broadcast; prune dead push endpoints; a failed push never fails the write.
113. **Notifications name the specific thing, where it is, and the date.**
114. **Remind once per item per period,** guaranteed by a unique log key. Duplicates and re-fires happened.
