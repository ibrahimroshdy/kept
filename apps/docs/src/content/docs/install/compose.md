---
title: Install with Docker Compose
description: Run Kept and its Postgres with Docker Compose, sign in for the first time, and keep the keys safe.
sidebar:
  order: 1
---

Docker Compose is the way to run Kept on one machine: Kept itself, Postgres 18 with pgvector, and,
if you want it, Caddy for HTTPS. You need Docker with the Compose plugin, and a machine with at
least 2 GB of RAM and 2 CPU cores ([what it needs](/install/hardware/)).

:::note[Built or pulled]
Releases are published to `ghcr.io/ibrahimroshdy/kept`, tagged `1`, `1.2` and `1.2.3`, never
`latest`; `1.0.0` is the first signed one. The images stay private until the repository is
public, so by default `compose.yaml` builds the image from a checkout of the repository and tags it
`kept:local`. To run a release instead, set `KEPT_IMAGE` in `.env` to a released tag and run
`docker compose pull`, and [verify it](/admin/verify-release/) first.
:::

## 1. Fill in `.env`

Next to `compose.yaml`, copy the example and fill it in. `.env` is never committed anywhere.

```sh
cp compose.env.example .env
```

- **Five database passwords** (`KEPT_DB_SUPERUSER_PASSWORD`, `KEPT_DB_OWNER_PASSWORD`,
  `KEPT_DB_APP_PASSWORD`, `KEPT_DB_AUTH_PASSWORD`, `KEPT_DB_SYSTEM_PASSWORD`). Generate each one,
  for example with `openssl rand -hex 32`: hex needs no escaping inside the database URLs Compose
  builds. They are read once, when the database volume is first created; changing one later also
  means `ALTER ROLE … PASSWORD` in `psql`.
- **`KEPT_PUBLIC_URL`**: the address people open, such as `https://kept.example.org`. Links, QR
  codes and the same-site check are built from it, so it must be exactly what the browser shows.

Everything else is optional; the comments in `compose.env.example` and the
[configuration reference](/reference/configuration/) say what each variable does.

## 2. Start it

```sh
docker compose up -d
```

Compose starts the database, waits for it to be healthy, runs the one-shot `migrate` service
(`kept migrate`, which applies the database migrations once, under a lock), and then starts Kept on
port 8080 (`KEPT_HTTP_PORT` changes the host port). On first start the database's init script
creates Kept's four database logins and the `pg_trgm`, `unaccent` and `vector` extensions.

## 3. Finish setup

Kept prints a one-time setup code when it starts with no admin yet:

```sh
docker compose logs kept | grep "KEPT SETUP CODE"
```

Open `KEPT_PUBLIC_URL`, enter the code, and create the first account: it becomes the instance
admin. To preset the code instead, set `KEPT_SETUP_CODE` in `.env` (six characters of 0–9 and A–Z
without I, L, O and U). A lost code is issued again with:

```sh
docker compose run --rm migrate admin setup-code
```

Wrong codes lock out for a while, per address and for the whole instance. If Kept sits behind a
proxy it doesn't trust, everyone shares the proxy's address; see
[reverse proxies](/install/reverse-proxy/).

## 4. Keep the keys

On first start, with `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET` unset, Kept generates both into the
`kept-config` volume and logs one line saying where. The secret key seals every secret value (AI
keys, the passwords you store in Kept): **a backup restores everything except those values unless
you also have the key.**

Print the keys and keep them somewhere other than this server, such as a password manager:

```sh
docker compose exec kept kept admin recovery-kit
```

Admin → Status asks you to acknowledge the recovery kit, and Kept requires it before the first
secret value, AI key or backup setting. See [the recovery kit](/admin/recovery-kit/).

## 5. Next

- [Put Kept on HTTPS](/install/https/): the camera, installing the app, push notifications and
  location only work over HTTPS.
- [Set up backups](/admin/backups/).
- Mail: set `KEPT_SMTP_URL` (`smtp://` or `smtps://`, with credentials) and `KEPT_SMTP_FROM` for
  password resets, invitations and reminders by email. Without them, reminders reach people in the
  app only, and Admin → Status says mail isn't configured.

## What Compose creates

| Volume | Holds | Back it up? |
|---|---|---|
| `kept-db` | the Postgres database | through Kept's backup, never by copying the volume while it runs |
| `kept-data` | uploaded files (with `KEPT_STORAGE=local`, the default) | through Kept's backup |
| `kept-config` | the generated `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET` only | keep the recovery kit instead |
| `caddy-data`, `caddy-config` | Caddy's certificates (the `https` profile) | no; Caddy gets new ones |

Kept's containers run as a non-root user (uid 10001) with a read-only root filesystem, every Linux
capability dropped and `no-new-privileges`. The `migrate` service holds the database owner's
login; the serving container holds it only once you give it one for the nightly backup
([backups](/admin/backups/#turning-it-on)).

## Web and worker on their own

One container serves the web app and runs the background jobs (`KEPT_ROLE=all`, the default). To
split them, run a second Kept service with `KEPT_ROLE=worker` beside one with `KEPT_ROLE=web`. A
worker serves no HTTP; the image's healthcheck follows `KEPT_ROLE` and checks the worker's job loop
instead, so neither needs an override (`compose.yaml` has the two services commented out). The
worker runs the nightly backup, so it is the one that needs the owner login and a directory
target's mount.
