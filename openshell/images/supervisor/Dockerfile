# baskule-openshell-supervisor:0.2: the patched openshell-supervisor from vendor/openshell
# (public_internet egress). Compile in deploy/v2/build-env: Ubuntu 24.04, matching this runtime's glibc.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
# The supervisor builds the workload CA bundle from its OWN system CA store (l7/tls.rs SYSTEM_CA_PATHS);
# without ca-certificates, TLS passthrough breaks Python requests in the computer.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 openshell-supervisor /openshell-supervisor
LABEL org.opencontainers.image.title=baskule-openshell-supervisor org.opencontainers.image.source=https://github.com/baskule/baskule
ENTRYPOINT ["/openshell-supervisor"]
