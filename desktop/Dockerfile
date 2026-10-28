# CI-only native desktop toolchain. The rootless runner builds and runs this image;
# it contains no deploy tooling, credentials, Docker socket, or live-stack configuration.
FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS node
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 pkg-config libsecret-1-dev libwayland-dev \
    libxkbcommon-dev imagemagick unzip xz-utils libgtk-3-0t64 libnss3 libasound2t64 libgbm1 \
    xvfb xauth dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH \
    T3CODE_TELEMETRY_ENABLED=false CARGO_BUILD_JOBS=2
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain 1.95.0 \
    && npm install --global --ignore-scripts pnpm@12.14.0
WORKDIR /workspace
