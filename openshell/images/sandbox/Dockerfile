# syntax=docker/dockerfile:1.4
# baskule-openshell-sandbox:local: the sandbox runtime image (the static `openshell-sandbox` binary that becomes the
# workload's PID 1), built from our fork because it enforces the boundary's concurrent-stream limit
# (BOUNDARY_MAX_CONCURRENT_STREAMS, raised with the supervisor's network-stream budget). Build context: the fork.
# Alpine's Rust targets musl natively and links statically, like upstream's x86_64-unknown-linux-musl artifact.
FROM rust:1.95-alpine AS build
RUN apk add --no-cache build-base cmake perl clang linux-headers protobuf protobuf-dev
WORKDIR /src
COPY . .
# protoc-bin-vendored ships a glibc protoc that cannot run on musl.
ARG CARGO_BUILD_JOBS=2
ENV PROTOC=/usr/bin/protoc PROTOC_INCLUDE=/usr/include CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    nice -n 10 cargo build --release --locked -p openshell-sandbox \
 && cp target/release/openshell-sandbox /openshell-sandbox \
 && ! ldd /openshell-sandbox 2>/dev/null | grep -q '=>'

FROM scratch
COPY --from=build --chmod=0555 /openshell-sandbox /openshell-sandbox
# Drivers override this identity to match the admitted workload (upstream default).
USER 65532:65532
LABEL org.opencontainers.image.title=baskule-openshell-sandbox org.opencontainers.image.source=https://github.com/baskule/baskule
ENTRYPOINT ["/openshell-sandbox"]
