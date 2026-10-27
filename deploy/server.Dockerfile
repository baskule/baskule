# baskule-server: the T3 Code fork (server + bundled web client), headless.
#
# Build context  = the fork (baskule/app, or a `git archive` export of it).
# Named context  = `deploy` -> baskule/deploy (entrypoint + settings renderer).
#   docker build -f deploy/server.Dockerfile --build-context deploy=deploy -t baskule-server:0.1 app/
# docker-compose.yml passes both (build.context + build.additional_contexts).
#
# v0.1.1 toolchain: Node ^24.13.1, pnpm 11.10.0 (corepack, from package.json "packageManager").

ARG NODE_VERSION=24.22.1

# ---------------------------------------------------------------------------------------------------------
# build: full Debian Node image (ships python3/make/g++ for node-pty's native build).
FROM node:${NODE_VERSION}-trixie AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 T3CODE_TELEMETRY_ENABLED=false \
    PNPM_HOME=/pnpm npm_config_update_notifier=false
RUN corepack enable
WORKDIR /src
COPY . .
# Install only what the server, web and build scripts need (skips mobile/desktop/marketing: no Expo, no Electron).
RUN --mount=type=cache,id=baskule-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter "@t3tools/monorepo" --filter "t3..." --filter "@t3tools/web..." --filter "@t3tools/scripts..."
RUN node_modules/.bin/vp run --filter @t3tools/web --filter t3 build \
 && test -f apps/server/dist/bin.mjs && test -f apps/server/dist/client/index.html
# Self-contained runtime tree: apps/server/dist + production node_modules (runtime externals such as node-pty).
RUN --mount=type=cache,id=baskule-pnpm-store,target=/pnpm/store \
    pnpm --filter t3 deploy --prod --legacy /out \
 && rm -f /out/dist/*.map \
 && node -e "require('/out/node_modules/node-pty')" \
 && du -sh /out /out/node_modules /out/dist

# ---------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim
# git: T3 probes git work trees (scratch is only offered outside one). curl: healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*
COPY --from=build /out /opt/t3
COPY --from=deploy --chmod=0755 server-entrypoint.sh /opt/baskule/entrypoint.sh
COPY --from=deploy render-settings.mjs /opt/baskule/render-settings.mjs
# The node image's `node` user is UID/GID 1000 (same as the computer's `agent`, D5).
# Volume mount points are pre-created and owned by 1000 so fresh named volumes inherit that ownership.
RUN mkdir -p /baskule/userdata/attachments /baskule/scratch && chown -R 1000:1000 /baskule
ENV NODE_ENV=production \
    T3CODE_TELEMETRY_ENABLED=false \
    T3CODE_NO_BROWSER=1 \
    BASKULE_AUTH_MODE=none \
    BASKULE_BASE_DIR=/baskule \
    BASKULE_SERVER_PORT=3773 \
    HOME=/home/node
USER 1000:1000
WORKDIR /baskule/scratch
EXPOSE 3773
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --start-interval=1s --retries=3 \
  CMD curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${BASKULE_SERVER_PORT}/" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/baskule/entrypoint.sh"]
