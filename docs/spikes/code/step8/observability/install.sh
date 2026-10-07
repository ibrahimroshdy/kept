#!/usr/bin/env bash
# O1 (step-8 T0b): install each candidate group into its own folder the way the image installs
# runtime deps (no install scripts), for linux/x64/glibc (the image's platform), and measure.
#   export PATH=/opt/homebrew/opt/node@24/bin:$PATH; bash install.sh
set -euo pipefail
cd "$(dirname "$0")"
OTEL_MIN=(
  @opentelemetry/api@1.9.1
  @opentelemetry/sdk-trace-node@2.11.0
  @opentelemetry/resources@2.11.0
  @opentelemetry/semantic-conventions@1.43.0
  @opentelemetry/exporter-trace-otlp-proto@0.222.0
  @opentelemetry/instrumentation@0.222.0
  @opentelemetry/instrumentation-http@0.222.0
  @opentelemetry/instrumentation-pg@0.74.0
  @fastify/otel@0.21.1
)
SDK_NODE=(
  @opentelemetry/api@1.9.1
  @opentelemetry/sdk-node@0.222.0
  @opentelemetry/instrumentation-http@0.222.0
  @opentelemetry/instrumentation-pg@0.74.0
  @fastify/otel@0.21.1
)
SENTRY=(@sentry/node@11.4.0)
SENTRY_CORE=(@sentry/core@11.4.0)
SENTRY_NODE10=(@sentry/node@10.76.0)
flags=(--save-exact --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc)
install() { local dir=$1; shift; (cd "$dir" && rm -rf node_modules && npm install "${flags[@]}" "$@" >/dev/null); }
install otel-min "${OTEL_MIN[@]}"
install otel-sdk-node "${SDK_NODE[@]}"
install sentry "${SENTRY[@]}"
install both "${OTEL_MIN[@]}" "${SENTRY[@]}"
install sentry-core "${SENTRY_CORE[@]}"
install sentry-node10 "${SENTRY_NODE10[@]}"
for d in otel-min otel-sdk-node sentry both sentry-core sentry-node10; do
  n=$(find "$d/node_modules" -name package.json -not -path '*/node_modules/*/node_modules/*/node_modules/*' -maxdepth 4 | wc -l | tr -d ' ')
  pk=$(node -e 'const l=require("./'"$d"'/package-lock.json");console.log(Object.keys(l.packages).filter(k=>k.startsWith("node_modules/")).length)')
  printf '%-14s %8s  %8s KiB(apparent)  %s packages in lock\n' "$d" "$(du -sh "$d/node_modules" | cut -f1)" "$(du -sk -A "$d/node_modules" 2>/dev/null | cut -f1 || echo ?)" "$pk"
done
