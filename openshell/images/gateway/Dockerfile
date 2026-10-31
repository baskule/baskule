# baskule-openshell-gateway:local: the image of the `baskule-openshell` container.
# One privileged container runs a PRIVATE dockerd (unix socket only, no bridge, no iptables) and the patched
# OpenShell gateway (Docker compute driver) against it, plus a tiny token-protected volume helper (volumes.py)
# that creates the per-space labelled volumes the gateway mounts at /sandbox/space.
# Sandboxes (= computers) and their supervisors therefore live inside this container's network namespace.
FROM docker:29-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977 AS docker

FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
ARG DEBIAN_FRONTEND=noninteractive
# python3: volumes.py. tini: PID 1. libstdc++6: the pinned Z3 shared library.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 libgomp1 python3 tini procps curl kmod \
 && rm -rf /var/lib/apt/lists/*
# Static docker engine binaries (dockerd with embedded containerd, shim, runc, docker CLI) + the dind cgroup-nesting wrapper.
COPY --from=docker /usr/local/bin/dockerd /usr/local/bin/containerd-shim-runc-v2 \
     /usr/local/bin/runc /usr/local/bin/docker /usr/local/bin/docker-init /usr/local/bin/docker-proxy \
     /usr/local/bin/dind /usr/local/bin/
COPY --chmod=0555 openshell-gateway openshell /usr/local/bin/
COPY --chmod=0555 libz3.so /usr/local/lib/libz3.so
RUN ldconfig
COPY gateway.toml /etc/openshell/gateway.toml
COPY --chmod=0555 entrypoint.sh /usr/local/bin/baskule-openshell-entrypoint
COPY --chmod=0444 volumes.py /usr/local/lib/baskule/volumes.py
# Supervisor + sandbox runtime image tarballs (added by build.sh), loaded into the private dockerd at start.
COPY images/ /usr/local/lib/baskule/images/
ENV OPENSHELL_TELEMETRY_ENABLED=false NO_COLOR=1 \
    XDG_DATA_HOME=/var/lib/openshell XDG_STATE_HOME=/var/lib/openshell/state HOME=/var/lib/openshell \
    OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml \
    OPENSHELL_DB_URL=sqlite:/var/lib/openshell/gateway.db?mode=rwc
VOLUME ["/var/lib/docker", "/var/lib/openshell"]
EXPOSE 47095 47096
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --start-interval=1s --retries=3 \
  CMD test -f /var/run/baskule-ready && curl -sf -o /dev/null http://127.0.0.1:47097/healthz && curl -sf -o /dev/null http://127.0.0.1:47096/healthz || exit 1
LABEL org.opencontainers.image.title=baskule-openshell-gateway org.opencontainers.image.source=https://github.com/baskule/baskule
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/baskule-openshell-entrypoint"]
