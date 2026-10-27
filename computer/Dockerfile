# baskule-computer:0.1 — "the agent's computer": Debian + Chromium + Node/Bun/Python + OpenCode 2 server.
# Build:  docker build -t baskule-computer:0.1 computer/
# Volumes: /data = the computer's private state (home + OpenCode DB/config);
#          /baskule/scratch = chat directories, shared with baskule-server (see README.md);
#          /baskule/userdata/attachments = chat uploads, baskule-server's, mounted read-only.

ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-trixie-slim AS node

# ---------------------------------------------------------------------------------------------------------
# Pinned npm-distributed tools, installed into fixed prefixes (no global `opencode` name collisions).
FROM node AS tools
ARG OPENCODE_VERSION=2.1.2
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG TARGETARCH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
# OpenCode: the npm wrapper pulls every libc/CPU variant (4 x 204 MB). Keep only one binary.
# amd64 uses the "baseline" (no AVX2) build so the image supports x86-64 CPUs without AVX2.
RUN mkdir -p /tmp/oc /opt/opencode/bin && cd /tmp/oc \
 && npm i --ignore-scripts --no-package-lock "@opencode/cli@${OPENCODE_VERSION}" \
 && case "$TARGETARCH" in arm64) v=cli-linux-arm64 ;; *) v=cli-linux-x64-baseline ;; esac \
 && cp "node_modules/@opencode/$v/bin/opencode" /opt/opencode/bin/opencode \
 && echo "${OPENCODE_VERSION}" > /opt/opencode/VERSION && rm -rf /tmp/oc /root/.npm
RUN mkdir -p /opt/playwright-mcp && cd /opt/playwright-mcp \
 && npm i --no-package-lock "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" && rm -rf /root/.npm
# Bun (baseline build on amd64 for the same reason as above).
ARG BUN_VERSION=1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && case "$TARGETARCH" in arm64) b=bun-linux-aarch64 ;; *) b=bun-linux-x64-baseline ;; esac \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/$b.zip" \
 && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 "/tmp/$b/bun" /usr/local/bin/bun

# ---------------------------------------------------------------------------------------------------------
FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils ca-certificates curl wget git jq unzip zip less file procps psmisc sudo tini tzdata locales \
      openssh-client ripgrep xz-utils make \
      python3 python3-pip python3-venv \
      chromium fonts-liberation2 fonts-dejavu-core fonts-noto-color-emoji \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/; s/^# *\(fr_FR.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Node LTS + npm/npx (official build), Bun, OpenCode, Playwright MCP.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
COPY --from=tools /opt/opencode /opt/opencode
COPY --from=tools /opt/playwright-mcp /opt/playwright-mcp

# Non-root user `agent` (UID/GID 1000). Passwordless sudo so the agent can apt-get install
# (note: apt installs live in the container layer and are lost when the container is recreated).
RUN groupadd -g 1000 agent && useradd -u 1000 -g 1000 -d /data/home -M -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent \
 && mkdir -p /data/home /baskule/scratch /baskule/userdata/attachments && chown -R agent:agent /data /baskule

COPY --chmod=0755 entrypoint.sh healthcheck.sh /opt/baskule/
COPY gen-config.mjs opencode.template.jsonc assistant-prompt.md /opt/baskule/

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/opencode/config \
    XDG_DATA_HOME=/data/opencode/data \
    XDG_STATE_HOME=/data/opencode/state \
    XDG_CACHE_HOME=/data/opencode/cache \
    BASKULE_CHATS_DIR=/baskule/scratch \
    NPM_CONFIG_PREFIX=/data/home/.local \
    BUN_INSTALL=/data/home/.bun \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_FREE_MODELS=1 \
    PATH=/data/home/.venv/bin:/data/home/.local/bin:/data/home/.bun/bin:/opt/opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

VOLUME /data
WORKDIR /baskule/scratch
EXPOSE 4096
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s --start-interval=1s --retries=3 CMD ["/opt/baskule/healthcheck.sh"]
# Starts as root only to fix /data ownership, then drops to `agent` (see entrypoint.sh).
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/baskule/entrypoint.sh"]
