# Build environment for the staging runner. Context: this directory; sources and caches are mounted at runtime.
FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS node
FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker
# Match the Ubuntu 24.04 staging host and OpenShell runtime.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client jq python3 rsync zstd build-essential pkg-config unzip \
    && rm -rf /var/lib/apt/lists/*
# Noble's libz3 (4.8) is too old for z3-sys 0.13 (>=4.13.3). Use the official glibc-2.39 build, pinned and checked.
# The exact same shared library is copied into the gateway runtime by openshell/build.sh.
RUN curl -fsSL https://github.com/Z3Prover/z3/releases/download/z3-5.1.0/z3-5.1.0-x64-glibc-2.39.zip -o /tmp/z3.zip \
    && echo 'f47be8d27d3230e823bf1eeede2fe0abaca55bb78d0b59974370e6689a92284a  /tmp/z3.zip' | sha256sum -c - \
    && unzip -q /tmp/z3.zip -d /tmp/z3 \
    && cp /tmp/z3/*/bin/libz3.so /usr/local/lib/ \
    && cp /tmp/z3/*/bin/z3 /usr/local/bin/ \
    && cp /tmp/z3/*/include/* /usr/local/include/ \
    && ldconfig && z3 --version \
    && rm -rf /tmp/z3 /tmp/z3.zip
COPY --from=node /usr/local /usr/local
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
# Rust as pinned by vendor/openshell/rust-toolchain.toml; the registry and build caches live on the host (run.sh).
ENV RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | CARGO_HOME=/usr/local/cargo sh -s -- -y -q --profile minimal \
      --default-toolchain 1.95.0 -c rustfmt,rust-src,rust-analyzer
RUN npm install --global --ignore-scripts pnpm@12.14.0
COPY run.sh /usr/local/bin/baskule-build
CMD ["baskule-build"]
