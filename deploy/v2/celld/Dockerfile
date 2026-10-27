# baskule-celld:0.2: stock celld 0.6.3 (official image, pinned by digest) + curl (health checks, bucket bootstrap)
# + jq and esbuild (the deploy job: `celld deploy` bundles with esbuild). The same image runs the nodes and the jobs.
FROM ghcr.io/denoland/celld:0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc
ARG ESBUILD_VERSION=0.28.2
RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-${ESBUILD_VERSION}.tgz" | tar -xz -C /tmp \
 && install -m 0755 /tmp/package/bin/esbuild /usr/local/bin/esbuild && rm -rf /tmp/package \
 && esbuild --version
COPY --chmod=0755 jobs.sh /usr/local/bin/baskule-celld-job
ENV CELLD_ESBUILD=/usr/local/bin/esbuild CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_WATCH=/var/lib/celld
