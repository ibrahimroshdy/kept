# Changelog

Kept's releases, newest first. Written by `scripts/changelog.mjs` from the commits' conventional
subjects when a release is cut (`scripts/release.sh`).

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
