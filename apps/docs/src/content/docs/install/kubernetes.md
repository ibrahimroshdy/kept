---
title: Install on Kubernetes with Helm
description: Kept's Helm chart for k3s and other Kubernetes clusters.
sidebar:
  order: 4
---

:::caution[Not yet tested on a real cluster]
The chart (`charts/kept/` in the repository) renders and validates (`helm lint`, `helm template`
and `kubeconform` run on every check), and each release pushes it with the image, but it hasn't
been installed on a real cluster yet. Treat a first install as a test. Its README holds the
values, the secrets to create and the commands; this page says what it does.
:::

The chart runs the same image as Compose, with the same [environment variables](/reference/configuration/).

- **Secrets first.** The chart never writes a secret: you create the database logins' secret (and,
  with the bundled Postgres, its superuser's) before installing, and reference the optional ones
  (the keys, S3, the backup's credentials, SMTP, the metrics token) by name in the values.
- **Postgres:** a bundled StatefulSet on the same pinned pgvector image as Compose, for a quick
  start, or your own PostgreSQL 18. With a database superuser's (or a provider admin's) secret, a
  Job creates Kept's roles and extensions; without one, run the
  [managed-Postgres SQL](/install/managed-postgres/#the-sql) yourself.
- **Migrations** run in a hook Job with the owner login, so the new version never serves before
  its migrations are applied. With a backup target configured, that Job first takes a
  [pre-upgrade snapshot](/admin/upgrades/). With the bundled Postgres the first install's Job runs
  after the install, so don't pass `--wait` to that first `helm install`.
- **Files stored locally** sit on a ReadWriteOnce volume, so the Deployment uses the `Recreate`
  strategy: an upgrade stops the old pod before the new one starts. Rolling updates come only with
  S3 file storage and the keys in a secret.
- **Backups run in the worker**, never in a CronJob: the same nightly job as in Compose, configured
  in Admin → Backups or locked by the chart's values.
- **Split web and worker** Deployments are an option; the worker is a single replica.
- **Volumes are kept** on `helm uninstall`; delete the claims yourself to remove the data.
- `helm test` asks the running Kept for `/readyz` and `/version`.

The chart's version is Kept's version: release 1.0.1 publishes chart 1.0.1. It is published as a signed OCI artifact beside the image with each release; see
[verifying a release](/admin/verify-release/).
