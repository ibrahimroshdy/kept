# syntax=docker/dockerfile:1
#
# Kept's production image (task 29, step-8 T15; D147, D151, D186, D193; engineering spec §7.11).
#
#   docker buildx build --platform linux/arm64 --load \
#     --build-arg REVISION=$(git rev-parse HEAD) --build-arg VERSION=1.2.3 -t kept:dev .
#
# One image for every role (KEPT_ROLE = all · web · worker) and for the one-shot `kept migrate`.
# It runs as uid 10001 (user `kept`) with a read-only root filesystem: the only writable paths are
# /data (local file storage), /config (first-boot keys, D193) and /tmp.
#
# Both installs share the pnpm store and pnpm's cache directory as BuildKit cache mounts, so a warm
# build reuses downloaded packages. (The lockfile's supply-chain check still asks the registry for
# metadata on every install; on a slow link that is most of a build's time.)
#
# Stages: `build` compiles on the build machine's own platform (its output is JavaScript, CSS and
# fonts, the same for every architecture), so a cross-build emulates only `prod-deps` (sharp's and
# Typst's per-architecture binaries) and the OS stage. `os` is Debian plus what Kept runs beside
# Node (pg_dump, restic, ssh) and is copied into the runtime as one flattened layer, which is what
# lets it drop npm, yarn and corepack (never run) instead of only hiding them under a later layer.

# node:24.21.0-bookworm-slim, pinned by its multi-arch index digest (read from Docker Hub,
# 2026-09-26). Debian/glibc rather than Alpine, for sharp/libvips.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ---------------------------------------------------------------------------------------------
# The manifests alone, so the dependency layers are reused until a manifest or the lockfile
# changes.
FROM scratch AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /src/
COPY apps/server/package.json /src/apps/server/
COPY apps/web/package.json /src/apps/web/
COPY packages/shared/package.json /src/packages/shared/
COPY packages/mcp/package.json /src/packages/mcp/

# ---------------------------------------------------------------------------------------------
# Everything, dev dependencies included, to compile the server, the shared package and the web.
# On the build machine's platform: nothing it produces is architecture-specific.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
# pnpm through corepack, at the version in package.json's packageManager field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack \
    CI=true
RUN corepack enable
WORKDIR /src
COPY --from=manifests /src/ ./
RUN corepack install
RUN --mount=type=cache,id=kept-pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=kept-pnpm-cache,target=/pnpm-cache \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --config.cache-dir=/pnpm-cache
COPY . .
# The web build reads KEPT_VERSION (vite.config.ts `define`), so a release's client says its real
# version in the sidebar and in the sync protocol's clientVersion (D148), not 0.0.0-dev.
ARG VERSION=0.0.0-dev
RUN pnpm --filter @kept/shared build \
 && pnpm --filter @kept/mcp build \
 && pnpm --filter @kept/server build \
 && KEPT_VERSION="${VERSION}" pnpm --filter @kept/web build
# In the repo @kept/shared and @kept/mcp (the tool contracts, step 6) export their TypeScript
# source (for tsx, vitest and vite); at runtime node needs the compiled files. Apply each one's
# publishConfig the way a publish would. drizzle-kit's `meta/*_snapshot.json` are for generating
# the next migration; drizzle's migrator and Kept's release guard read only `meta/_journal.json`
# and the `.sql` files, so the image leaves them out (~30 MB).
RUN node -e ' \
  const fs = require("node:fs"); \
  for (const file of ["packages/shared/package.json", "packages/mcp/package.json"]) { \
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")); \
    Object.assign(pkg, pkg.publishConfig); \
    delete pkg.publishConfig; \
    delete pkg.devDependencies; \
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n"); \
  }' \
 && find apps/server/migrations/meta -name '*_snapshot.json' -delete

# ---------------------------------------------------------------------------------------------
# Runtime dependencies of the server (and of @kept/shared and @kept/mcp) only, for the target
# architecture. No install scripts: none of them needs one (pnpm-workspace.yaml allows builds for
# esbuild alone, a dev tool). Then the trim (spike R3): better-auth's optional peers pull vitest,
# drizzle-kit and their build tooling into a prod install; docker/prune-optional-peers.mjs
# removes every store entry the shipped packages never reach (~90 MiB).
FROM ${NODE_IMAGE} AS prod-deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack \
    CI=true
RUN corepack enable
WORKDIR /src
COPY --from=manifests /src/ ./
RUN corepack install
RUN --mount=type=cache,id=kept-pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=kept-pnpm-cache,target=/pnpm-cache \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm-store \
      --config.cache-dir=/pnpm-cache --filter '@kept/server...'
RUN --mount=type=bind,source=docker/prune-optional-peers.mjs,target=/tmp/prune-optional-peers.mjs \
    node /tmp/prune-optional-peers.mjs /src >/tmp/pruned.json

# ---------------------------------------------------------------------------------------------
# restic (step 8, D64; spike R1, docs/spikes/2026-10-06-step8-restic.md): 0.19.1, read from
# github.com/restic/restic/releases (2026-10-06). The SHA-256s are the release's own SHA256SUMS,
# whose signature verified against restic's key CF8F 18F2 8445 7597 3F79 D4E1 91A6 868B D3F7 A907
# (restic.net/gpg-key-alex.asc). One stage per architecture, each with its literal checksum;
# TARGETARCH picks one. bzip2 is installed in that stage only, never in the image.
FROM ${NODE_IMAGE} AS restic-amd64
ADD --checksum=sha256:f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c \
    https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2 /restic.bz2

FROM ${NODE_IMAGE} AS restic-arm64
ADD --checksum=sha256:a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465 \
    https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_arm64.bz2 /restic.bz2

FROM restic-${TARGETARCH} AS restic
RUN apt-get update \
 && apt-get install -y --no-install-recommends bzip2 \
 && bunzip2 /restic.bz2 \
 && chmod 0755 /restic \
 && /restic version
# Its licence (BSD-2-Clause) at the release's tag, by the checksum the spike recorded.
ADD --checksum=sha256:6f08a01a9fab5b24e139a09f15cc24a73087c7bc09e3bacf099fdf2d767bf897 \
    https://raw.githubusercontent.com/restic/restic/v0.19.1/LICENSE /restic-LICENSE

# ---------------------------------------------------------------------------------------------
# The operating system the runtime gets, flattened into one layer below.
FROM ${NODE_IMAGE} AS os

# pg_dump and pg_restore for backups and `kept admin backup | restore` (T31c, D207). They must be
# the database's major version, 18 (an older pg_dump refuses a newer server), and Debian
# bookworm's own client is 15, so they come from PGDG: the key pinned by its checksum (fingerprint
# B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8), the package pinned to the version in
# bookworm-pgdg's index for both amd64 and arm64 (read 2026-09-27). Plain http, as the official
# postgres image uses: apt checks every package against the key.
#
# openssh-client is restic's SFTP transport (step 8, spike R1), from Debian bookworm, pinned to
# the version in bookworm's index for both architectures (read 2026-10-06). Pinned like the
# Postgres client: a build after Debian publishes the next security update fails here and the pin
# is bumped, rather than the image quietly changing.
#
# Full Perl (~49 MB installed) comes only from postgresql-client-common, whose /usr/bin/pg_dump,
# psql, … are Perl wrappers that pick a version. Kept never runs them: the PATH below puts
# /usr/lib/postgresql/18/bin first. So Perl is purged (perl-base, which Debian requires, stays)
# and each wrapper link is pointed at the version-18 binary of the same name, or removed when 18
# has none: `pg_dump` reaches the same binary whatever the PATH. The notices stage reads dpkg
# after this, so they list what the image really ships.
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/pgdg.asc
RUN chmod 0644 /usr/share/keyrings/pgdg.asc \
 && echo 'deb [signed-by=/usr/share/keyrings/pgdg.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
      >/etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client-18=18.6-1.pgdg12+2 \
      openssh-client=1:9.2p1-2+deb12u10 \
 && dpkg --purge --force-depends perl libperl5.36 perl-modules-5.36 \
 && for f in /usr/bin/*; do \
      [ "$(readlink "$f")" = ../share/postgresql-common/pg_wrapper ] || continue; \
      if [ -x "/usr/lib/postgresql/18/bin/${f##*/}" ]; then \
        ln -sfn "/usr/lib/postgresql/18/bin/${f##*/}" "$f"; \
      else \
        rm -f "$f"; \
      fi; \
    done \
 && /usr/bin/pg_dump --version | grep -q '(PostgreSQL) 18\.' \
 && /usr/bin/pg_restore --version | grep -q '(PostgreSQL) 18\.' \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log

COPY --from=restic /restic /usr/local/bin/restic
COPY --from=restic /restic-LICENSE /usr/share/doc/restic/LICENSE

# The runtime user. ssh refuses to start for a uid with no passwd entry ("No user exists for uid
# 10001", spike R1), so SFTP backups need it; Helm's runAsUser: 10001 matches it too.
# npm, yarn and corepack come with the Node base and are never run; the flattening drops them, and
# Node's C headers (for compiling native addons, ~6 MB) and its changelog with them.
# `kept` on the PATH: `docker compose run --rm migrate admin …`, `docker compose exec kept kept …`.
# The volumes belong to the runtime user; a fresh named volume copies this ownership.
RUN groupadd --gid 10001 kept \
 && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin kept \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg /usr/local/include/node /usr/local/CHANGELOG.md \
 && printf '#!/bin/sh\nexec node /app/apps/server/dist/cli/index.js "$@"\n' >/usr/local/bin/kept \
 && chmod 0755 /usr/local/bin/kept \
 && mkdir -p /data /config \
 && chown 10001:10001 /data /config \
 && chmod 0700 /data /config

# ---------------------------------------------------------------------------------------------
# Third-party notices (D151; spike R3): generated from this architecture's own pruned
# node_modules, the OS packages above, Node's and restic's licences. It also fails the build when
# a shipped package's licence is off the runtime allowlist (scripts/check-licences.mjs), so the
# licence scan covers exactly what the image ships.
FROM os AS notices
# Node.js's LICENSE at the base image's tag: the base image doesn't ship it. Its SHA-256 was
# computed from that file on 2026-10-06 (157,609 bytes).
ADD --checksum=sha256:5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace \
    https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE /notices/node-LICENSE
COPY --from=prod-deps /src/node_modules /notices/node_modules
COPY --from=build /src/apps/server/assets/fonts/*-OFL.txt /notices/fonts/
ARG VERSION=0.0.0-dev
ARG TARGETARCH
# Standard licence texts for packages that ship none: Debian's common-licenses, and MIT and ISC
# from SPDX's license-list-data v3.29.0 (docker/licence-texts/, which Debian doesn't hold).
RUN --mount=type=bind,source=scripts/third-party-notices.mjs,target=/notices/bin/third-party-notices.mjs \
    --mount=type=bind,source=scripts/check-licences.mjs,target=/notices/bin/check-licences.mjs \
    --mount=type=bind,source=docker/licence-texts,target=/notices/texts \
    dpkg-query -W -f '${Package}\t${Version}\n' >/notices/dpkg.tsv \
 && node /notices/bin/third-party-notices.mjs \
      --store /notices/node_modules/.pnpm \
      --texts /notices/texts --texts /usr/share/common-licenses \
      --dpkg /notices/dpkg.tsv --dpkg-docs /usr/share/doc \
      --node-licence /notices/node-LICENSE \
      --node-version "$(node -p process.versions.node)" \
      --restic-licence /usr/share/doc/restic/LICENSE \
      --restic-version "$(restic version | cut -d' ' -f2)" \
      --extra "IBM Plex Sans (the inventory report's font)|OFL-1.1|/notices/fonts/IBMPlexSans-OFL.txt" \
      --extra "IBM Plex Sans Arabic (the inventory report's font)|OFL-1.1|/notices/fonts/IBMPlexSansArabic-OFL.txt" \
      --extra "IBM Plex Mono (the inventory report's font)|OFL-1.1|/notices/fonts/IBMPlexMono-OFL.txt" \
      --version "${VERSION}" --arch "${TARGETARCH}" \
      --out /THIRD-PARTY-NOTICES.txt

# ---------------------------------------------------------------------------------------------
FROM scratch AS runtime
COPY --from=os / /

# Stamped by the build (D147, D186, L100). REVISION is the commit; SOURCE the repository.
ARG VERSION=0.0.0-dev
ARG REVISION=
ARG SOURCE=https://github.com/ibrahimroshdy/kept

LABEL org.opencontainers.image.title="Kept" \
      org.opencontainers.image.description="Kept: a home inventory you can self-host" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

# KEPT_SOURCE_URL defaults from the labels (D186): the repository at the exact commit when the
# revision is known, the repository otherwise. Forks override it at build or run time (D147).
# NODE_ENV=production makes boot refuse an unset KEPT_SOURCE_URL (config/env.ts). The version's
# own Postgres bin directory goes first on the PATH, so nothing depends on Debian's
# version-picking wrapper. KEPT_RESTIC_BIN names the pinned restic (it is on the PATH too).
ENV NODE_ENV=production \
    KEPT_VERSION="${VERSION}" \
    KEPT_REVISION="${REVISION}" \
    KEPT_SOURCE_URL="${SOURCE}${REVISION:+/tree/${REVISION}}" \
    KEPT_CONFIG_DIR=/config \
    KEPT_DATA_DIR=/data \
    KEPT_RESTIC_BIN=/usr/local/bin/restic \
    HOME=/tmp \
    PATH=/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app
# The pnpm layout is kept as built (root node_modules/.pnpm plus per-package symlinks), so the
# relative links from apps/server to packages/shared resolve exactly as they do in the repo.
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=prod-deps /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /src/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /src/packages/mcp/node_modules ./packages/mcp/node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/apps/server/package.json ./apps/server/package.json
COPY --from=build /src/apps/server/dist ./apps/server/dist
# The inventory report's fonts (D201): eight TTFs the server build converts from the @ibm/plex-*
# devDependencies, with their OFL texts. dist/ already holds the report's child renderer and
# Typst template beside the modules that load them (src/reports/render/build-assets.ts).
COPY --from=build /src/apps/server/assets ./apps/server/assets
COPY --from=build /src/apps/server/migrations ./apps/server/migrations
COPY --from=build /src/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/packages/mcp/package.json ./packages/mcp/package.json
COPY --from=build /src/packages/mcp/dist ./packages/mcp/dist
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY LICENSE ./LICENSE
COPY --from=notices /THIRD-PARTY-NOTICES.txt ./THIRD-PARTY-NOTICES.txt
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

USER 10001:10001
VOLUME ["/data", "/config"]
EXPOSE 8080

# web or all: /readyz on KEPT_PORT. A worker (KEPT_ROLE=worker) serves no HTTP: the same script
# checks its liveness file instead (docker/healthcheck.mjs), so a split deployment needs no
# healthcheck override.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

# The tracing preload (D84, T14) loads no OpenTelemetry package unless OTEL_EXPORTER_OTLP_ENDPOINT
# is set; it has to run before fastify and pg load, so it is an --import, not an import.
ENTRYPOINT ["node", "--import", "/app/apps/server/dist/observability/tracing.js", "/app/apps/server/dist/main.js"]
