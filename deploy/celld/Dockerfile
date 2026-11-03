# baskule-celld:local: stock celld 0.6.3 (official image, pinned by digest) + curl (health checks, bucket bootstrap)
# + jq and esbuild (the deploy job: `celld deploy` bundles with esbuild). The same image runs the nodes and the jobs.
FROM ghcr.io/denoland/celld:0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc AS source
ARG ESBUILD_VERSION=0.28.2
RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-${ESBUILD_VERSION}.tgz" | tar -xz -C /tmp \
 && install -m 0755 /tmp/package/bin/esbuild /usr/local/bin/esbuild && rm -rf /tmp/package \
 && esbuild --version
COPY --chmod=0755 deploy/celld/backup.sh /usr/local/bin/baskule-backup
COPY --chmod=0755 deploy/celld/jobs.sh /usr/local/bin/baskule-celld-job
COPY --chmod=0755 deploy/celld/sync-plugins.sh /usr/local/bin/baskule-sync-plugins
ENV CELLD_ESBUILD=/usr/local/bin/esbuild CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_WATCH=/var/lib/celld

# Release deploy jobs need no checkout or host bind mount.
FROM source AS release
COPY platform/wrangler.json /src/platform/wrangler.json
COPY platform/dist/ /src/platform/dist/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/baskule/
LABEL org.opencontainers.image.source=https://github.com/baskule/baskule org.opencontainers.image.licenses="MIT AND Apache-2.0"
