# CI-only native desktop toolchain. The rootless runner builds and runs this image;
# it contains no deploy tooling, credentials, Docker socket, or live-stack configuration.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS node
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 pkg-config libsecret-1-dev libwayland-dev \
    libxkbcommon-dev imagemagick unzip xz-utils libgtk-3-0t64 libnss3 libasound2t64 libgbm1 \
    xvfb xauth dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local /usr/local
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 T3CODE_TELEMETRY_ENABLED=false CARGO_BUILD_JOBS=2
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain 1.95.0 \
    && corepack enable pnpm
WORKDIR /workspace
