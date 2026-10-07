---
title: Security model
description: What an operator should know about how Kept keeps households apart, seals secrets, signs people in, and what leaves the server.
---

This page is the operator's summary. The full threat model is in the
[product design, §13](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md),
and the mechanisms are in the
[engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)
(§7.1–§7.3 and §7.10 for the database, keys and sign-in; §3.1b and §3.2 for limits).

## Households are kept apart by the database

Kept connects to Postgres with four logins, each allowed only what its job needs (spec §7.1):

| Login | Used by | What it may do |
|---|---|---|
| `kept_owner` | `kept migrate`, `kept admin`, the nightly backup | owns the schema; never used to serve a request |
| `kept_app` | every web request, instance-admin routes included | reads and writes app tables, always under row-level security (`NOBYPASSRLS`, `FORCE` RLS on every table) |
| `kept_auth` | sign-in (Better Auth) | its own `auth` schema only |
| `kept_system` | background jobs that span households (reminder scan, retention), the setup code | explicit system policies only |

Every request runs in a transaction that names the signed-in person, and every policy asks one
function which locations that person belongs to. When no person is set, the policies return
nothing, so a code path that forgets the scope fails closed. A schema-wide leak test checks the
request, auth and worker paths. The depth is in [row-level security](/developers/rls/).

What this means for you: the serving container never holds the owner's login unless you give it
one for backups ([backups](/admin/backups/#turning-it-on)). An instance admin has **no in-app
access** to other people's locations; an operator with database access can bypass that, which is
why the database itself must stay private to the server.

## Keys and encryption

- **`KEPT_SECRET_KEY`** seals every secret value: secret fields on things, AI keys, notification
  channel settings, webhook secrets, the web push private key, the backup password. AES-256-GCM
  with a per-row data key, each ciphertext bound to its table, row and field, so one can't be
  swapped for another (spec §7.3).
- **`KEPT_AUTH_SECRET`** signs sessions and tokens. It is separate so either can be rotated alone.
- **Generated on first boot** when both are unset, into the config volume (never the data
  volume), with one log line saying where. Set them yourself with `kept admin gen-key`; boot
  refuses a key shorter than 32 bytes, and refuses one set without the other.
- **Neither is in the database or the backup.** Keep [the recovery kit](/admin/recovery-kit/).
  Without the secret key, a restore brings back everything except secret values and AI keys.
- **Rotation:** `kept admin rotate-key` makes a new key current and re-wraps every sealed value;
  the old key is kept as a retired version so older backups still open. `--resume` finishes an
  interrupted run, `--drop <version>` removes a retired key nothing uses
  ([the CLI](/admin/cli/#commands)).
- **AI keys are write-only:** once saved, Kept shows only their last four characters.

## Signing in

Kept uses Better Auth on its own login and schema. What an account can sign in with:

- **Email and password.** A password reset signs the account out everywhere, and the owner is
  told by mail when a credential changes.
- **Passkeys**, registered for the host name of `KEPT_PUBLIC_URL`.
- **Two-factor** with an authenticator app (TOTP) or a passkey that verified the user. An emailed
  one-time code is never a second factor. A location's owner can require two-factor for everyone
  in it.
- **Magic links** for existing accounts only (no open sign-up), valid 15 minutes. Mailed tokens
  travel in the link's `#fragment` and are spent by a POST from the page, so a mail scanner that
  opens links can't use them up; only a hash is stored.
- **Usernames** for managed accounts (people without an email address).
- **OIDC**, when `KEPT_OIDC_ISSUER` and `KEPT_OIDC_CLIENT_ID` are set
  ([configuration](/reference/configuration/)). An outside identity is never linked to an account
  because the email matches; a new person gets in by invite, or by an allowed domain or group.
  The identity provider's tokens are never stored.

**Sessions** last 30 days over HTTPS, extended once a day of use, with `Secure`, `__Secure-`
prefixed cookies. Over plain HTTP they last 12 hours and are never extended, and Kept refuses
the actions that reveal or change a secret ([HTTPS](/install/https/)). Sensitive actions ask for
the password again, or a sign-in in the last ten minutes.

**Requests from other sites** are refused: a write that carries Kept's cookie must come from the
origin of `KEPT_PUBLIC_URL`, or it gets 403 before the session is even read. The pages are served
with a `default-src 'self'` content security policy, may not be framed, and get HSTS when the
public URL is HTTPS.

## Rate limits

From spec §3.2, as built:

| What | Limit |
|---|---|
| Sign-in attempts | 5 a minute per address; per account and address, 20 an hour, with delays that grow after the fourth failure (up to 5 minutes) rather than a lockout |
| Other auth routes | 100 a minute per address and route |
| API and MCP, per token | 120 reads and 30 writes a minute |
| Password reset and magic link | 3 an hour per account |

Limits are kept in the database, so replicas share them. The client's address comes from the
socket, or from `X-Forwarded-For` only when the connection is from an address in
`KEPT_TRUSTED_PROXIES` ([reverse proxies](/install/reverse-proxy/#trust-the-proxy-and-only-the-proxy)).

## Outbound requests (SSRF)

Kept fetches only addresses someone configured: an AI provider's base URL, webhooks, push,
an OIDC issuer, an OAuth client's metadata, a Homebox server to import from, barcode lookups and
the update check. Each goes through one guarded fetch
([`apps/server/src/net/ssrf.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/net/ssrf.ts)):

- the address is checked **when the connection is made**, after the name resolves, so a name that
  changes between a check and the request can't slip through;
- private, loopback, link-local (including the cloud metadata address), carrier-grade NAT,
  multicast and reserved ranges are refused, IPv4 and IPv6;
- redirects are refused, so a public host can't bounce the request inward.

A refused address is `400 private_address`. On a self-hosted server an instance admin can allow
private addresses (**Admin → Settings → Allow private addresses**), which a provider on your own
network, such as [Ollama](/admin/ollama/), needs. It is off by default.

## Hostile input

Imports and uploads are treated as hostile. The defaults (spec §3.1b):

| Limit | Default |
|---|---|
| Import ZIP | 5 GB uncompressed, 100:1 compression per entry, 200,000 entries, no symlinks |
| Images | decoded up to 100 megapixels, one at a time under 3 GB of RAM |
| PDFs | parsed in a child process, 20 s and 256 MB |
| Uploads | `KEPT_MAX_FILE_MB` (25 MB by default), refused before the body is read |

Stored files are fetched through a five-minute signed link on a path that reads no session, with
`nosniff` and a `default-src 'none'; sandbox` policy, and as a download unless the file is one of
Kept's own re-encoded JPEGs. Exported CSV cells that start like a formula are neutralised.

## What leaves the server

- **Nothing about Kept itself.** There is no telemetry of any kind; the sign-in library's own
  telemetry is switched off. Tracing and error reporting go only to a collector you set
  ([monitoring](/admin/observability/#tracing-and-error-reporting)).
- **The update check is off by default.** On, it asks GitHub for the latest release once a day,
  sending nothing but the request ([upgrades](/admin/upgrades/#knowing-theres-a-new-version)).
- **What an AI provider sees**, when a location uses one: photos as a re-encoded copy with
  EXIF and XMP removed (Kept refuses to send an image that still has them), the fixed prompt and
  the location's languages for extraction, the question and the tool results the asker's role
  allows for the assistant, and descriptive fields for semantic search. **Never secret values**,
  and never money for search. Kept's own record of each call stores tokens and cost, never the
  prompt, the image, the reply or the key. See [AI providers](/users/ai-providers/).
- **Backups** are restic snapshots encrypted with a password of at least 12 characters before they
  leave; with no password there is no backup ([backups](/admin/backups/)).

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on the repository (the **Security** tab →
**Report a vulnerability**); it is the only channel, and there is no security email address. Don't
open a public issue. [SECURITY.md](https://github.com/ibrahimroshdy/kept/blob/main/SECURITY.md)
has the details and the supported versions, which apply from 1.0. To check that an image is the
one the maintainer built, see [verifying a release](/admin/verify-release/).
