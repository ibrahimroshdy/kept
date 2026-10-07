#!/usr/bin/env bash
# SPIKE (step 3, T0). Reproduce the web spikes (V17 Serwist, V18 driver.js hints, the scanner's
# wasm under CSP) on a scratch checkout. Never run this on a branch you mean to keep: it edits
# apps/web. Undo with `git checkout -- apps/web pnpm-lock.yaml && git clean -fd apps/web`.
#
#   export PATH=/opt/homebrew/opt/node@24/bin:$PATH
#   bash docs/spikes/code/step3/apply.sh
#
# Then the AI SDK spike (mock model, no keys). @ai-sdk/provider is needed only for its types
# (LanguageModelV4GenerateResult); pnpm won't resolve it through `ai` otherwise (TS2307):
#   pnpm -C apps/server add -E ai@7.0.116
#   pnpm -C apps/server add -D -E @ai-sdk/provider@4.0.18
#   cp docs/spikes/code/step3/server/ai-sdk.spike.test.ts apps/server/src/
#   cp docs/spikes/code/step3/server/vitest.spike.config.ts apps/server/
#   (cd apps/server && pnpm exec vitest run -c vitest.spike.config.ts --silent=false)
# The real-provider script (pending keys) is server/ai-providers.spike.ts; its header says how.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
spike="$root/docs/spikes/code/step3/web"
web="$root/apps/web"

pnpm -C "$web" add -E serwist@9.5.12 @serwist/window@9.5.12 barcode-detector@3.2.2 zxing-wasm@3.1.3 driver.js@1.8.0
pnpm -C "$web" add -D -E @serwist/vite@9.5.12 @serwist/build@9.5.12 @axe-core/playwright@4.13.0

cp "$spike/vite.config.ts" "$web/vite.config.ts"
cp "$spike/src/sw.ts" "$spike/src/spike-register.ts" "$spike/src/spike-scanner.ts" "$spike/src/spike-hints.ts" "$web/src/"
cp "$spike/spike-scanner.html" "$spike/spike-hints.html" "$spike/csp-server.mjs" "$spike/playwright.spike.config.ts" "$web/"
mkdir -p "$web/spike-e2e"
cp "$spike"/spike-e2e/*.spec.ts "$web/spike-e2e/"
grep -q "spike-register" "$web/src/main.tsx" || echo "import './spike-register';" >> "$web/src/main.tsx"

cd "$web"
pnpm exec vite build
pnpm exec playwright test -c playwright.spike.config.ts
