# Paperless-ngx answers

Recorded on 2026-10-15 for D248 from a throwaway **Paperless-ngx 3.3.1** (image
`paperlessngx/paperless-ngx:3.3.1`, digest
`sha256:cb91bfb468e63025a9d10c01b54c33665113668eee61b490db96de19b860b9c4`, SQLite, Valkey 9.0.6)
with five synthetic PDFs, sent `Accept: application/json; version=9` and a token, exactly as
`src/paperless/client.ts` asks. The instance was thrown away afterwards.

| File | Request |
|---|---|
| `ping.json` | `GET /api/documents/?page_size=1&fields=id` (answered with `X-Api-Version: 10`, `X-Version: 3.3.1`) |
| `list.json` | `GET /api/documents/?page=1&page_size=24&fields=id,title,created,document_type,correspondent,tags,mime_type&ordering=-created` |
| `search.json` | the same with `query=bosch` instead of `ordering` (the correspondent matches too) |
| `doc.json` | `GET /api/documents/1/?fields=…` |
| `types.json`, `corr.json`, `tags.json` | `GET /api/document_types/`, `/api/correspondents/`, `/api/tags/` with `id__in=…&page_size=100` |
| `missing.json` | `GET /api/documents/9999/` (404) |
| `bad.json` | any call with a wrong token (401) |
| `v99.json` | any call with `version=99` (406) |
| `thumb.webp` | `GET /api/documents/1/thumb/` with `Accept: */*` (`image/*` is answered 406) |

`paperless.test.ts` replays them to the client; `test/paperless-fake.ts` answers the same way for
the route tests.
