# Build context is openshell/.build/gateway, shared with the Docker gateway.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 openshell-gateway /usr/local/bin/openshell-gateway
COPY --chmod=0555 libz3.so /usr/local/lib/libz3.so
RUN ldconfig
COPY licenses/ /usr/share/licenses/baskule/
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/openshell-gateway"]
LABEL org.opencontainers.image.source=https://github.com/baskule/baskule org.opencontainers.image.licenses="MIT AND Apache-2.0"
