---
title: The recovery kit
description: The keys and backup credentials that turn a backup back into a working Kept. Keep them anywhere but the server.
sidebar:
  order: 4
---

Kept seals every secret value it stores (AI keys, and the secrets you keep on things, such as a
router's Wi-Fi password) with `KEPT_SECRET_KEY`, and signs sessions with `KEPT_AUTH_SECRET`. Neither is in the database or
the backup, on purpose: someone who gets your backup shouldn't get your secrets with it. The other
side of that: **without the key, a restore brings back everything except secret values and AI keys,
which stay unreadable for good.**

The recovery kit is everything you'd need to rebuild Kept from its backup. Keep it in a password
manager or on paper, somewhere that wouldn't be lost with the server.

## What it holds

- `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET`;
- after a key rotation, the key's version (`KEPT_SECRET_KEY_VERSION`) and every retired key
  (`KEPT_SECRET_KEYS_RETIRED`), which older backups still need;
- the backup's restic repository, **its password, and its storage credentials** (the S3 keys and
  region, or the SFTP key and the server's pinned host key as a `known_hosts` line), or "No backup
  configured";
- the instance's address, Kept's version and revision, when the kit was made;
- the restore steps in plain words, and the commands to
  [read your inventory with restic alone](/admin/read-with-restic/), with the repository filled in.

It is plain text, or a printable page made from the same lines (no script, nothing loaded from
anywhere).

## Getting it

From the server, at any time:

```sh
docker compose exec kept kept admin recovery-kit
```

It prints to the terminal; nothing is written anywhere. `--format html` gives the printable page,
and `--out <file>` writes it to a file readable by you only. The keys print even when the database
is down; the backup half needs the database owner's login (`KEPT_OWNER_DATABASE_URL`, the
`compose.override.yaml` that [backups](/admin/backups/#turning-it-on) use gives it), and without it
the kit says it is missing. With that login, the print counts as a download (below) and is audited.

From the web: **Admin → Status → Recovery kit → Download recovery kit**, as an instance admin, over
HTTPS only, after entering your password again (or, for an account without one, within ten minutes
of signing in: a passkey sign-in counts; otherwise "Sign in again"). Choose a text file or a
printable page. Every download is audited, and nothing of the kit is kept anywhere a later visitor
could open it.

## When Kept asks for it

Setup doesn't wait for the kit, but Kept asks you to acknowledge it before the first of: storing a
secret value, adding an AI key, or setting up backups. Until then Admin → Status asks for it; a download counts as
that acknowledgement. The status page asks again when the kit you downloaded is out of date: after
the backup settings change or the key is rotated (`kept admin rotate-key`).

## If you set the keys yourself

With `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET` in your own environment (generate each with
`kept admin gen-key`), Kept uses them as given and the `kept-config` volume stays empty. The kit
still prints them; keeping a copy is still your job.

## Rotating the key

```sh
docker compose exec kept kept admin rotate-key
```

makes a new key current and re-wraps every stored secret under it. It needs the database owner's
login, so the `kept` service must have `KEPT_OWNER_DATABASE_URL` (the `compose.override.yaml` that
[backups](/admin/backups/#turning-it-on) use gives it). It says what to set if you manage the keys
yourself. The old key moves to the retired list, so backups made before the
rotation still open: download a new kit afterwards.
