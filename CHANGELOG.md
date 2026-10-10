# Changelog

Kept's releases, newest first. Written by `scripts/changelog.mjs` from the commits' conventional
subjects when a release is cut (`scripts/release.sh`).

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
