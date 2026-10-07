---
title: Monitoring
description: Health checks, the status page, alerts, metrics, logs, and optional tracing and error reporting.
sidebar:
  order: 12
---

Kept sends nothing about itself anywhere unless you set it up: **no telemetry of any kind**, not
even opt-in install counts.

## Health checks

| Path | Answers |
|---|---|
| `/healthz` | 200 while the process serves HTTP. For a liveness probe. |
| `/readyz` | 200 when both of the web's database connections answer, else 503. For readiness, and the image's own `HEALTHCHECK`. |
| `/version` | the version, the commit it was built from, the source repository, and where the third-party notices are (`/notices.txt`, in the image). |

A container running only the worker (`KEPT_ROLE=worker`) serves no HTTP. The image's
`HEALTHCHECK` follows `KEPT_ROLE`: for the worker it checks that the job loop has polled the
database within the last two minutes (it touches `/tmp/kept-worker-alive` as it goes), so a split
deployment needs no healthcheck override.

## The status page and alerts

**Admin → Status** shows what needs attention: the recovery kit, mail, failed background jobs, the
reminder scan, and backups: the backup's age, the last restore drill, bucket versioning, disk
space, the release and its migrations, the update check, HTTPS and the connectors. Admin alerts
reach instance admins in the app, by mail and by push; each is resolved when its cause clears.

## Metrics

Set `KEPT_METRICS_TOKEN` and `/metrics` serves Prometheus text to requests that send it as a bearer
token (`Authorization: Bearer <token>`); without the variable, the path doesn't exist.

| Metric | What |
|---|---|
| `kept_build_info{version, revision}` | always 1; the running build |
| `kept_process_uptime_seconds` | seconds since the process started |
| `kept_process_resident_memory_bytes` | the process's memory |
| `kept_db_pool_connections{pool, state}` | connections per database pool: total, idle, waiting |
| `kept_backup_last_success_timestamp_seconds` | when the last good backup finished (0 before the first) |
| `kept_backup_last_run_status{status}` | 1 for the last finished run's status, 0 for the others |
| `kept_disk_used_ratio{volume}` | how full the data disk and a directory backup target are |
| `kept_update_available` | 1 when the update check has seen a newer release |

No label ever holds a path or a target. A database that can't answer leaves the backup, disk and
update lines out; the scrape itself still succeeds.

## Logs

JSON lines on standard output (`KEPT_LOG_FORMAT=json`, the default), or `pretty` for reading
`docker compose logs` by eye; `KEPT_LOG_LEVEL` sets the level. Every request has an id, sent back
in the `x-request-id` response header, so a report can be matched to its log line. Tokens in URLs
are redacted from the log, and secrets and passwords are never logged.

## Tracing and error reporting

Both are optional and off by default.

- **Tracing:** with `OTEL_EXPORTER_OTLP_ENDPOINT` set, Kept sends OpenTelemetry traces of its HTTP
  requests and database queries to your collector. Unset, none of the tracing code even loads, and
  a collector that is down never slows a request.
- **Error reporting:** with a Sentry-compatible DSN in `KEPT_ERROR_DSN`, unhandled errors are reported with the
  request id and route, and never a request body, header, query string, name or anything stored in
  a location.
