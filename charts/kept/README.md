# Kept's Helm chart

The same image, variables and behaviour as Compose (D16, D85, D186), on Kubernetes. The published
chart's version is Kept's own: chart `1.2.3` installs Kept 1.2.3 (plan Q17). Every value is in
[values.yaml](values.yaml), validated by [values.schema.json](values.schema.json).

**Status:** `helm lint`, `helm template` for four value sets and `kubeconform -strict` at
Kubernetes 1.37 pass (`bash scripts/check-helm.sh`, ci-local's `helm` step). It has **not yet been
installed on a cluster**: the kind smoke in that script and a real install are the maintainer's
rows on the step-8 device checklist. Fixes from that install become golden-file cases.

## Before installing: the secrets

The chart never writes a secret. Each secret holds variables under their own names, as Compose's
`.env` does. Use hex passwords: they go inside `postgres://` URLs.

```sh
kubectl create namespace kept
pw() { openssl rand -hex 32; }
# The four database logins (always).
kubectl -n kept create secret generic kept-db \
  --from-literal=KEPT_DB_OWNER_PASSWORD="$(pw)" --from-literal=KEPT_DB_APP_PASSWORD="$(pw)" \
  --from-literal=KEPT_DB_AUTH_PASSWORD="$(pw)" --from-literal=KEPT_DB_SYSTEM_PASSWORD="$(pw)"
# The bundled Postgres's superuser (or, for external Postgres with roles.create, the server admin's password).
kubectl -n kept create secret generic kept-postgres --from-literal=POSTGRES_PASSWORD="$(pw)"
```

Optional, each referenced by a value:

| Value | The secret holds |
|---|---|
| `keys.existingSecret` | `KEPT_SECRET_KEY`, `KEPT_AUTH_SECRET` (`kept admin gen-key` makes one); after a rotation also `KEPT_SECRET_KEY_VERSION`, `KEPT_SECRET_KEYS_RETIRED`. Empty: generated on first boot into the config volume (D193). |
| `storage.s3.existingSecret` | `KEPT_S3_ACCESS_KEY_ID`, `KEPT_S3_SECRET_ACCESS_KEY` |
| `backup.existingSecret` | `KEPT_BACKUP_PASSWORD`, and for S3 `KEPT_BACKUP_S3_ACCESS_KEY_ID`, `KEPT_BACKUP_S3_SECRET_ACCESS_KEY`. Each one locks its field in Admin → Backups. |
| `smtp.existingSecret` | `KEPT_SMTP_URL` |
| `metrics.tokenSecret` | `KEPT_METRICS_TOKEN` |

## Install

```sh
helm install kept oci://<registry>/charts/kept --version <X.Y.Z> -n kept \
  --set publicUrl=https://kept.example.org \
  --set roles.existingSecret=kept-db --set postgres.superuserSecret=kept-postgres
```

`<registry>` is where the release published the chart, beside the image (the release notes in
`docs/releases/` give the exact reference). A released chart pins the image by digest; check its
signature first (below).

- **Don't use `--wait` on the first install with the bundled Postgres.** The migrate Job runs
  `post-install` there (a `pre-install` hook would run before the chart's Postgres exists), and
  `--wait` waits for a ready Kept before running post-install hooks, which never comes. Kept is
  ready once the Job has migrated the database.
- Then read the NOTES: the setup code is in the server's log
  (`kubectl -n kept logs deploy/kept | grep 'KEPT SETUP CODE'`), and the recovery kit comes from
  `kubectl -n kept exec deploy/kept -- kept admin recovery-kit > kept-recovery-kit.txt`. Keep the
  kit off the cluster.
- `helm test kept -n kept` asks the running Kept for `/readyz` and `/version`.

## What it runs

- **Postgres.** `postgres.bundled: true` (the default): a one-replica StatefulSet on the pinned
  pgvector image Compose uses; its first start runs [files/roles.sh](files/roles.sh), which makes
  Kept's four logins and the extensions. `false`: your PostgreSQL 18 at `postgres.external`; with
  `roles.create: true` a `pre-install` Job runs the same script as the server's admin
  (`postgres.superuserSecret`, user `postgres.external.superuser`); with `false`, run the
  managed-Postgres SQL from the docs yourself first. Never point a Kept login at the admin user.
- **Migrations** (`kept migrate`) run in a hook Job with the owner login, the keys and the backup
  settings, so a populated database gets its pre-upgrade snapshot first. On upgrade it runs
  `pre-upgrade`: the new version never serves before its migrations. When the keys live in the
  config volume, or the backup in a directory volume, the Job is scheduled beside the pod that
  holds them (both are ReadWriteOnce).
- **Kept** runs as uid 10001 with a read-only root filesystem, no capabilities and `/tmp` in an
  `emptyDir`. Startup and readiness probes ask `/readyz`, liveness `/healthz`; a `preStop` sleep
  lets the Service drop a pod before it stops. Service links are off: Kubernetes would otherwise
  set `KEPT_PORT=tcp://…` for a Service named `kept`.
- **Strategy.** `Recreate` whenever the pod holds a ReadWriteOnce volume (local files, generated
  keys, a backup directory), because the old pod must let go of it first; `RollingUpdate`
  (`maxSurge: 1`, `maxUnavailable: 0`) only without one, which means S3 files and secret keys
  (D186). Migrations are additive (D82), so the old version runs on the new schema meanwhile.
- **Split** (`split.enabled`): a web Deployment of `split.web.replicas` and one worker
  (`KEPT_ROLE=worker`, Recreate, its liveness from `docker/healthcheck.mjs --worker`). It needs
  `keys.existingSecret`, and S3 files or a ReadWriteMany files volume; the chart refuses otherwise.
- **Backups run in the worker** (or the single server), never in a CronJob (D186): that pod holds
  the owner login while `backup.enabled` is true. Configure them in Admin → Backups, or lock them
  with `backup.existingSecret` and `backup.env`; `backup.persistence` gives a directory target its
  own volume (a volume in the same cluster is not off the machine: prefer a bucket or SFTP; for
  SFTP mount the key and `known_hosts` with `extraVolumes` and point the variables at them).
- **Volumes are kept** on `helm uninstall` (`helm.sh/resource-policy: keep`), and so is the bundled
  Postgres's claim (a StatefulSet's claims always are). Delete the PVCs yourself to remove the data.

## Verify a released chart

```sh
cosign verify --key cosign.pub --insecure-ignore-tlog <registry>/charts/kept@sha256:<digest>
```

`--insecure-ignore-tlog` while releases are signed without the public transparency log (the
repository is private, plan Q14); drop it once they are. The digest and the command are in the
release's `docs/releases/X.Y.Z.md`.

## Changing the chart

Edit, then `bash scripts/check-helm.sh`; when a render changes on purpose, review the diff and
`bash scripts/check-helm.sh --update`. Leave `version` in Chart.yaml at `0.0.0-dev`: the release
sets the published chart's version to Kept's, so a chart change ships with the next release.
