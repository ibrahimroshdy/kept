#!/bin/sh
# Runs inside node:24 bookworm-slim (arm64), as root, with this directory mounted at /spike (ro).
# Installs each engine into a scratch dir, records its install size, then measures every engine.
set -e
mkdir -p /w && cd /w
cp -r /spike/lib /spike/*.mjs /spike/report.typ /spike/package.json /spike/fonts /spike/sample . 2>/dev/null
export npm_config_update_notifier=false
# Docker Desktop's VM resolves AAAA records but has no IPv6 route: force IPv4 or apt/npm hang.
export NODE_OPTIONS=--dns-result-order=ipv4first
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99ipv4
echo "== npm install (all engines)"
npm install --no-audit --no-fund --ignore-scripts --loglevel=http 2>&1 | tail -3
du -sm node_modules | sed 's/^/node_modules total MB: /'
echo "== per-engine closure sizes (MB)"
for d in @react-pdf fontkit pdfkit yoga-layout hyphen @swc brotli restructure unicode-trie unicode-properties bidi-js jay-peg linebreak png-js color-string media-engine emoji-regex-xs abs-svg-path parse-svg-path normalize-svg-path svg-arc-to-cubic-bezier @myriaddreamin playwright-core react; do
  [ -e node_modules/$d ] && du -sm node_modules/$d | tr '\n' ' '
done; echo
echo "== chromium headless shell + system libraries"
# Not `install --with-deps`: that also pulls xvfb, Mesa/LLVM and five CJK/emoji font packages,
# none of which a headless PDF sidecar needs (our fonts are inlined). Install the browser, then
# Playwright's Chromium library list only.
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx --no-install playwright-core install chromium-headless-shell >/tmp/pw.log 2>&1 || { tail -20 /tmp/pw.log; exit 1; }
du -sm /ms-playwright
export CHROMIUM_PATH=$(find /ms-playwright -type f \( -name chrome-headless-shell -o -name headless_shell \) | head -1)
ls -la "$CHROMIUM_PATH"
MISSING=$(ldd "$CHROMIUM_PATH" | awk '/not found/{print $1}' | sort -u | tr '\n' ' ')
echo "missing libs: $MISSING"
BEFORE=$(du -sxm / 2>/dev/null | cut -f1)
apt-get update -qq >/dev/null
# Playwright's own Debian 12 list for Chromium (playwright-core 1.63.0, lib/coreBundle.js,
# deps["debian12-x64"].chromium, reused for arm64) plus fontconfig/freetype from its "tools" list.
# Its "tools" also has xvfb and seven font packages, which a headless PDF renderer doesn't need.
PKGS="libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libfontconfig1 libfreetype6"
echo "packages: $PKGS"
apt-get install -y -qq --no-install-recommends $PKGS >/tmp/apt.log 2>&1 || { tail -20 /tmp/apt.log; exit 1; }
apt-get clean; rm -rf /var/lib/apt/lists/*
AFTER=$(du -sxm / 2>/dev/null | cut -f1)
echo "system libraries added MB: $((AFTER - BEFORE))"
echo "still missing: $(ldd "$CHROMIUM_PATH" | awk '/not found/{print $1}' | tr '\n' ' ')"
echo "CHROMIUM_PATH=$CHROMIUM_PATH"
echo "== measurements (2 rounds each)"
for i in 1 2; do
  node measure.mjs render-reactpdf.mjs all
  node measure.mjs render-typst.mjs all
  node measure.mjs render-chromium.mjs all
done
cp out/*.pdf /spike-out/ 2>/dev/null || true
