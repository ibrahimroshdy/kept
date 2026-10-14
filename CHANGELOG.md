# Changelog

Kept's releases, newest first. Written by `scripts/changelog.mjs` from the commits' conventional
subjects when a release is cut (`scripts/release.sh`).

## 1.4.0 (2026-10-14)

### Features

- **capture:** email-in, receipts from a location's IMAP mailbox (D231) (#63) (174180d)
- **capture:** several things in one photo, behind an admin switch (D230) (#62) (364520a)

### Documentation

- **release:** the 1.3.0 record (#61) (80e3dfa)

## 1.3.0 (2026-10-14)

### Features

- **vehicles:** import a vehicle's history from LubeLogger (D229) (#59) (772a778)
- **reports:** email a report, or have it sent every week or month (D228) (#58) (6baabd0)
- **notify:** ntfy and Telegram channels (D227) (#57) (a9d998c)

### Documentation

- **release:** the 1.2.0 record (#55) (9706f22)

## 1.2.0 (2026-10-14)

### Features

- **auth:** Google sign-in, and linking outside sign-ins from Settings (D226) (#53) (84cade8)
- **accounts:** delete your own account, with 30 days to keep it (D225) (#52) (2366e50)

### Documentation

- **release:** the 1.1.0 record (#51) (b3876a8)

## 1.1.0 (2026-10-14)

### Features

- **locations:** places panel and readable location addresses (D224) (#47) (76bea1f)
- **views:** the layout isn't part of a saved view (D223) (#46) (b59a01d)
- **web:** a location's contents as a grid (#45) (8dc2b6d)
- **web:** a location's contents fold by section (#44) (8571bb3)
- **labels:** print a location's unprinted labels from its page (#43) (b2925ee)

### Documentation

- **release:** the 1.0.6 record (#49) (1093ca6)
- **design:** the screens board shows 1.1's places panel, grid and folding sections (#48) (9873b61)

## 1.0.6 (2026-10-14)

### Fixes

- **modules:** Moving mode isn't built yet: What to track shows it as Coming soon, and it can't be switched on (#41) (75df21b)
- **release:** the README installs the release, and a tag must be new (#40) (49595f9)
- **sync:** the op ledger lasts as long as an op may be resent (#39) (53092b2)
- **import:** a CSV that isn't UTF-8 is refused, not imported as garbled names (#38) (37c034c)
- **backup:** problems the backups found no longer stay quiet (#37) (14b6bc6)
- **mcp:** update_thing files an alias by its script, not as English (#36) (2d5ee60)
- **imports:** a failed Homebox step forgets the brand it made, so the next item imports (#35) (dffdae4)
- **web:** nothing follows you into another location or to the next person (#34) (5227a0d)
- **assistant:** confirmed cards send the thing's version only to tools that check it (#33) (d61b643)
- **auth:** tokens end with the account: a disabled user's stop, a claim revokes them (#32) (f124fa3)
- **sync:** the orphan purge keeps an upload whose queued op may still come (#31) (15c123d)
- **test:** date fixtures count calendar days in Cairo, not 24-hour steps from UTC (#30) (12d3e64)
- **web:** the guided tour no longer sends people off its own path (#27) (5a958c8)
- **web:** review fixes for #2, #3, #18 and the docs move; two flaky tests (#26) (5decc9a)
- **mcp:** add_thing resolves a short-ID or container place_id, and a saved write never answers an error (#25) (7efae71)

### Documentation

- the images are public and releases are signed into the transparency log: the install, verify and security pages say so (#41) (75df21b)
- **design:** the screens board catches up with 1.0.5 (#29) (ea49553)
- **release:** the 1.0.4 and 1.0.5 records, and fixes 1.0.1's changelog missed (#28) (c649b8b)

## 1.0.5 (2026-10-11)

### Fixes

- **web:** tour Next/Got it hover stays amber instead of flipping gray (#23) (f98fb16)

### Documentation

- README badge to keptinventory.info (#24) (a6c9dae)

## 1.0.4 (2026-10-11)

No user-facing changes: tagged on 1.0.3's commit (e722c41) before the README fix it was cut for
had merged, so it is 1.0.3 rebuilt. That fix shipped in 1.0.5.

## 1.0.3 (2026-10-11)

### Features

- **web:** full interactive guided tour with Keep/Discard (#21) (74d9fca)

## 1.0.2 (2026-10-10)

### Features

- **web:** "Show me around" tours seven stops, not four (#19) (6e97d1c)
- **web:** navigate inside a location — back link, outline, readable URLs (#18) (389ff57)
- **mcp:** add_thing says per item whether its place was found or made (#17) (2131dec)
- **web:** location settings General gains timezone and currency (#16) (ce82015)

### Fixes

- **web:** isolate subject names in notification headings and loan texts (#14) (09a2d0b)
- **web:** a sheet closing must not traverse history while a navigation is in flight (#10) (8d3d1ec)

### Documentation

- **release:** the 1.0.1 record, and the missing 1.0.0 one (#9) (58dcf50)

### Other

- release: retry creating the GitHub release on server errors (#13) (954cc33)

## 1.0.1 (2026-10-08)

### Features

- **web:** Get started asks the instance admin to set up email while mail is off (993698f)
- **contributing:** a CLA beside the DCO, signed once on a contributor's first pull request (74a625a)

### Fixes

- **capture:** photos named after AI is connected show their names without a reload (#4) (a364a83)
- **assistant:** fit a free-tier plan's per-minute limit, and say so when a question doesn't (#3) (7ae1cde)
- **web:** the sidebar expands while the assistant's panel is docked (#2) (ec414e7)
- **web:** a page left blank because the app's code failed to load reloads once by itself (#8) (164b8ec)
- **web:** fuel trends opened offline before their first load show nothing instead of an error (#8) (164b8ec)
- **inbox:** a receipt's shop and date fill in when its reading arrives after the review opened,
  unless you've typed your own (#8) (164b8ec)

### Security

- **deps:** sharp 0.35.5, whose bundled librsvg renders uploaded brand logos; patched form-data,
  source-map-js, postcss-selector-parser and esbuild in the build tools (#6) (ef7d70c)

## 1.0.0 (2026-10-07)

The first release.

- **Inventory:** locations, rooms, shelves, boxes and things, with photos, documents, tags,
  custom fields, quantities, saved views, search and a restorable trash.
- **Capture:** photograph a thing, a receipt or a label, online or offline; your AI provider
  suggests the details.
- **Labels:** printable sheets with a short ID and a QR code; scan one to open what it's on.
- **The household:** shared locations with roles, lending, schedules, warranties, paperwork, an
  insurance report, and reminders in the app, by mail, by push and in a calendar feed.
- **Vehicles and machines:** readings, services, fuel and running costs.
- **AI assistant and MCP server:** ask in plain words; Claude and other AI agents connect at
  `/mcp` with a personal token or OAuth.
- **Backups you can read:** nightly restic backups with a copy that opens in a browser; imports
  from Homebox and CSV; full exports.
- **Five languages:** English, Arabic (right to left), French, German and Italian; installs on a
  phone as an app.
- **Releases:** a multi-arch image (amd64, arm64) and a Helm chart, both signed with cosign.
