# baskule-computer:local: the agent's computer as an OpenShell sandbox image (architecture E5).
# Build:  docker build --network host -t baskule-computer:local computer/   (or computer/build.sh)
# No OpenCode, no entrypoint: OpenShell replaces ENTRYPOINT/CMD with its own runtime and launches the sandbox
# command (computerd uses `sleep infinity`); everything else runs through exec.
# Layout: WORKDIR /sandbox (OpenShell workspace), /sandbox/space = per-space persistent volume,
# HOME=/sandbox/space/home (so pip --user, npm prefix, bun, browser profile all persist).

ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS node

FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

FROM node AS tools
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG BUN_VERSION=1.3.14
ARG PNPM_VERSION=12.15.0
ARG UBOL_VERSION=2026.1021.1354
ARG UBOL_SHA256=0ff92d3e33437e0fa389a16a3d4c3a486fbda08e33114e07859db1f58d789d0b
ARG TARGETARCH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN mkdir -p /opt/playwright-mcp && cd /opt/playwright-mcp \
 && npm i --no-package-lock "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" && rm -rf /root/.npm
# pnpm outside the user's npm prefix, so `npm i -g` on the volume never shadows or breaks it.
RUN npm i -g --prefix /opt/pnpm --no-package-lock "pnpm@${PNPM_VERSION}" && rm -rf /root/.npm
# Bun (baseline build on amd64: supports CPUs without AVX2).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && case "$TARGETARCH" in arm64) b=bun-linux-aarch64 ;; *) b=bun-linux-x64-baseline ;; esac \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/$b.zip" \
 && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 "/tmp/$b/bun" /usr/local/bin/bun
# uBlock Origin Lite (MV3): the shared browser loads it unpacked (baskule-browser-bridge). Ads and trackers on a
# page left open otherwise exhaust the computer's network streams for every other process.
RUN curl -fsSL -o /tmp/ubol.zip \
      "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip" \
 && echo "${UBOL_SHA256}  /tmp/ubol.zip" | sha256sum -c - \
 && mkdir -p /opt/ublock-lite && unzip -q /tmp/ubol.zip -d /opt/ublock-lite

FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk util-linux procps psmisc ca-certificates curl wget git jq unzip zip \
      less file openssh-client ripgrep xz-utils bzip2 make tzdata locales \
      python3 python3-pip python3-venv python-is-python3 \
      chromium fonts-liberation2 fonts-dejavu-core fonts-noto-color-emoji \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui pandoc poppler-utils qpdf ffmpeg \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/; s/^# *\(fr_FR.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && command -v setsid >/dev/null
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
COPY --from=tools /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/bin/pnpm /usr/local/bin/pnpm && ln -s /opt/pnpm/bin/pnpx /usr/local/bin/pnpx
COPY --from=uv /uv /uvx /usr/local/bin/
# Document libraries for every space, system-wide (read-only in the sandbox); `pip install --user` still works and
# wins for a package the user upgrades.
COPY python-requirements.txt /opt/baskule/python-requirements.txt
RUN uv pip install --system --break-system-packages --no-cache -r /opt/baskule/python-requirements.txt
COPY --from=tools /opt/playwright-mcp /opt/playwright-mcp
COPY browser/ /opt/baskule-browser/
RUN cd /opt/baskule-browser && npm i --no-package-lock playwright-core@1.60.0 ws@8.22.0 && rm -rf /root/.npm
# The bridge loads a writable copy of it from /tmp/baskule-browser/ublock-lite; that path fixes the extension id
# the managed policy below names.
COPY --from=tools /opt/ublock-lite /opt/baskule-browser/ublock-lite
COPY prune-ublock-lite.py /tmp/
RUN python3 /tmp/prune-ublock-lite.py /opt/baskule-browser/ublock-lite && rm /tmp/prune-ublock-lite.py
COPY chromium-policies/ /etc/chromium/policies/managed/
COPY --chmod=0755 bin/ /usr/local/bin/
# pip: Debian marks the system Python externally managed; allow `pip install x` (it falls back to a user install
# under $HOME/.local, i.e. on the persistent volume). Virtualenvs work as usual.
RUN printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf \
 && groupadd -g 1000 agent && useradd -u 1000 -g 1000 -d /sandbox/space/home -M -s /bin/bash agent \
 && mkdir -p /sandbox/space/home && chown -R 1000:1000 /sandbox

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TZ=Etc/UTC \
    HOME=/sandbox/space/home \
    NPM_CONFIG_PREFIX=/sandbox/space/home/.local \
    BUN_INSTALL=/sandbox/space/home/.bun \
    PNPM_HOME=/sandbox/space/home/.local/share/pnpm \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_PATH=/usr/local/bin/chromium-baskule \
    PATH=/sandbox/space/home/.local/bin:/sandbox/space/home/.local/share/pnpm:/sandbox/space/home/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LABEL org.opencontainers.image.title=baskule-computer org.opencontainers.image.version=0.5.0
WORKDIR /sandbox
USER 1000:1000
ENTRYPOINT []
CMD ["sleep", "infinity"]
