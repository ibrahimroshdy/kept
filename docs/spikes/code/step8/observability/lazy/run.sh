#!/usr/bin/env bash
# O1: which way of loading OTel lazily actually instruments node:http, pg and Fastify under ESM.
#   export PATH=/opt/homebrew/opt/node@24/bin:$PATH; bash run.sh
set -uo pipefail
cd "$(dirname "$0")"
E=http://127.0.0.1:9   # a dead collector, as ci-local's prod-boot uses (L90)
VARIANT=A-unset            node --import ./record.mjs main-static.mjs
VARIANT=A-static-tla       OTEL_EXPORTER_OTLP_ENDPOINT=$E node --import ./record.mjs main-static.mjs
VARIANT=B-dynamic          OTEL_EXPORTER_OTLP_ENDPOINT=$E node --import ./record.mjs main-dynamic.mjs
VARIANT=C-import-preload   OTEL_EXPORTER_OTLP_ENDPOINT=$E node --import ./record.mjs --import ./tracing.mjs main-preload.mjs
VARIANT=D-hook-preload     OTEL_EXPORTER_OTLP_ENDPOINT=$E node --import ./record.mjs --import ./register-hook.mjs main-preload.mjs
VARIANT=D-hook-unset       node --import ./record.mjs --import ./register-hook.mjs main-preload.mjs
