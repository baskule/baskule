# syntax=docker/dockerfile:1.7

# celld 0.6.3 with warm-worker retention and native service deployment tooling.
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS runtime-build
WORKDIR /src
ADD --checksum=sha256:aedb3406d49ea27909ff96328423ff97e431273b5c8fb9ba00161690e65dbc52 https://codeload.github.com/denoland/celld/tar.gz/8702f6d186c77698dbfb30cf29e3b1922a88f008 /tmp/celld.tar.gz
RUN tar -xzf /tmp/celld.tar.gz --strip-components=1 -C /src && rm /tmp/celld.tar.gz
COPY deploy/celld/patches/ /patches/
RUN patch -p1 < /patches/0001-preserve-warm-stateless-worker.patch
RUN patch -p1 < /patches/0002-service-deployments.patch
RUN patch -p1 < /patches/0003-preserve-warm-cell-isolate.patch
COPY deploy/celld/tests/retention.rs crates/logic/tests/baskule_retention.rs
COPY deploy/celld/tests/pool_lifecycle.rs crates/celld/tests/baskule_pool_lifecycle.rs
COPY deploy/celld/tests/service_deployments.rs crates/celld/tests/baskule_service_deployments.rs
RUN --mount=type=cache,id=baskule-celld-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=baskule-celld-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=baskule-celld-target,target=/src/target,sharing=locked \
    cargo test --release --locked -p celld-logic --test baskule_retention && \
    cargo test --release --locked -p celld --lib cell_retention_tests -- --test-threads=1 && \
    cargo test --release --locked -p celld --test baskule_pool_lifecycle && \
    cargo test --release --locked -p celld --test baskule_service_deployments && \
    cargo build --release --locked -p celld --bin celld && \
    install -Dm755 target/release/celld /out/celld

# Preserve the official runtime's system dependencies and license notices.
# baskule-celld:local: celld + curl (health checks, bucket bootstrap)
# + jq and esbuild (the deploy job: `celld deploy` bundles with esbuild). The same image runs the nodes and the jobs.
FROM ghcr.io/denoland/celld:0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc AS source
COPY --from=runtime-build /out/celld /usr/local/bin/celld
LABEL dev.baskule.celld.revision="8702f6d186c77698dbfb30cf29e3b1922a88f008" dev.baskule.celld.patch="preserve-warm-stateless-worker-v1,service-deployments-v1,warm-cell-v1"
ARG ESBUILD_VERSION=0.28.2
RUN apt-get update && apt-get install -y --no-install-recommends curl jq && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-${ESBUILD_VERSION}.tgz" | tar -xz -C /tmp \
 && install -m 0755 /tmp/package/bin/esbuild /usr/local/bin/esbuild && rm -rf /tmp/package \
 && esbuild --version
COPY --chmod=0755 deploy/celld/backup.sh /usr/local/bin/baskule-backup
COPY --chmod=0755 deploy/celld/jobs.sh /usr/local/bin/baskule-celld-job
ENV CELLD_ESBUILD=/usr/local/bin/esbuild CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_WATCH=/var/lib/celld

# Release deploy jobs need no checkout or host bind mount.
FROM source AS release
COPY platform/wrangler.json platform/wrangler.web.json /src/platform/
COPY platform/dist/ /src/platform/dist/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/baskule/
LABEL org.opencontainers.image.source=https://github.com/baskule/baskule org.opencontainers.image.licenses="MIT AND Apache-2.0"
