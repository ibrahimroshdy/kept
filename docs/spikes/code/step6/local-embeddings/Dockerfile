# syntax=docker/dockerfile:1
#
# S6.5 (D207): Kept's production image plus the local-embeddings runtime, to measure what the
# runtime adds (image size, memory) and to run harness.mjs under the 2 GB floor's limits.
#
#   docker build --build-arg BASE=kept:ci-arm64 --build-arg PRUNE=1 -t kept-s65:arm64-pruned .
#
# BASE is an existing Kept image (built from the repo's Dockerfile); it is only read, never
# changed. The runtime is installed with npm into apps/server/spike/ with --ignore-scripts, as
# Kept's own prod-deps stage installs (no install scripts; onnxruntime-node's postinstall only
# fetches optional CUDA binaries). PRUNE=1 removes what a linux/<arch> node process never loads:
#   - onnxruntime-node's prebuilt binaries for the other platforms (darwin, win32, the other
#     linux arch);
#   - onnxruntime-web's dist/ (transformers.node.mjs bundles the ORT web JS it needs and loads
#     onnxruntime-node for inference);
#   - the duplicate sharp (+ its @img binaries): npm resolves ^0.35.4 to its own copy, while in
#     the workspace pnpm would reuse Kept's; Node then resolves `sharp` from apps/server's own
#     node_modules, the one Kept already loads.
ARG BASE=kept:ci-arm64
FROM ${BASE}
ARG PRUNE=0
USER root
WORKDIR /app/apps/server/spike
COPY package.json ./
# The npm cache goes to a throwaway directory removed in the same layer (the image's HOME is /tmp,
# so npm's default cache would otherwise stay in the layer as /tmp/.npm).
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier \
      --cache /tmp/s65-npm-cache \
 && rm -rf /tmp/s65-npm-cache \
 && if [ "$PRUNE" = "1" ]; then \
      arch=$(node -p process.arch) \
      && cd node_modules/onnxruntime-node/bin/napi-v6 \
      && rm -rf darwin win32 \
      && find linux -mindepth 1 -maxdepth 1 ! -name "$arch" -exec rm -rf {} + \
      && cd /app/apps/server/spike \
      && rm -rf node_modules/onnxruntime-web/dist node_modules/sharp node_modules/@img ; \
    fi \
 && du -sk node_modules > /app/apps/server/spike/node_modules.du
COPY harness.mjs queries.json model-*.json ./
USER 10001:10001
ENTRYPOINT ["node", "--expose-gc", "/app/apps/server/spike/harness.mjs"]
