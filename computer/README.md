# baskule-computer:local — the agent's computer (an OpenShell sandbox image)

`./build.sh` builds the image (`docker build --network host -t baskule-computer:local computer` from the repository root).

| | |
|---|---|
| Base | `debian:trixie-slim` (digest-pinned), user `agent` uid/gid 1000, `WORKDIR /sandbox`, `HOME=/sandbox/space/home` |
| Tools | bash, coreutils, findutils, grep, sed, gawk, util-linux (`setsid`), procps (`pgrep`), psmisc, curl, wget, git, jq, ripgrep, zip/unzip, xz, bzip2, make, ssh client, Python 3.13 + pip + venv (`python` → `python3`), uv 0.13.5, Node 24.22.1 + npm/npx/corepack, pnpm 12.15.0 (`/opt/pnpm`), Bun 1.3.14 (baseline build), locales en_US/fr_FR, ca-certificates |
| Documents and media | LibreOffice headless (writer, calc, impress: `soffice --headless --convert-to`), pandoc, poppler-utils, qpdf, ffmpeg; Python libraries pinned in `python-requirements.txt`, installed system-wide (python-docx, openpyxl, python-pptx, pypdf, reportlab, pandas, matplotlib, xlsxwriter) |
| Browser | Chromium (Debian, 156 at build time) + fonts; `@playwright/mcp@0.0.83` in `/opt/playwright-mcp`; uBlock Origin Lite (pinned, sha256-checked, pruned to 8 lists by `prune-ublock-lite.py`) in `/opt/baskule-browser/ublock-lite`, settings in `chromium-policies/` |
| No | OpenCode, sudo, tini, entrypoint (OpenShell replaces ENTRYPOINT/CMD; computerd launches `sleep infinity`) |

Wrappers in `/usr/local/bin` (`bin/`):
- `chromium-baskule`: Chromium with `--no-sandbox --no-zygote --in-process-gpu --disable-dev-shm-usage --disable-quic`
  (Chromium's own sandbox cannot start inside OpenShell: no user namespaces, seccomp; QUIC/UDP is not mediated). With
  `--load-extension`, it adds `DisableLoadExtensionCommandLineSwitch` to the caller's `--disable-features` list
  (Chromium ignores the switch otherwise; a second `--disable-features` would replace Playwright's list).
- `baskule-browser-bridge`: starts T3's browser bridge (the browser members watch and the agent drives) with uBlock
  Origin Lite, loaded from a writable copy in `/tmp/baskule-browser/ublock-lite`: Chromium writes an unpacked
  extension's indexed rules into its directory, and `/opt` is read-only. The managed policy names the extension id
  derived from that path. The extension adds ~1 s to a browser start (measured; ~2.5 s before pruning).
- `baskule-browser ensure|status|stop`: the computer's shared headless Chromium, DevTools on `127.0.0.1:9222`,
  profile in `~/.baskule/chromium` (persistent). Used by computerd's CDP tunnel.
- `playwright-mcp`: Playwright MCP over stdio, attached to the shared browser (`--cdp-endpoint`);
  `BASKULE_BROWSER=isolated` launches a private browser instead.

pip: `/etc/pip.conf` sets `break-system-packages`, so `pip install x` falls back to a user install in
`~/.local` (on the persistent volume), which wins over the preinstalled system packages; virtualenvs work normally.
npm global prefix and Bun live in `~/.local`, `~/.bun`; pnpm's global bin in `~/.local/share/pnpm` (`PNPM_HOME`).
The image is ~2.4 GB, stored once per Docker daemon and shared by every computer (overlayfs): computer start time does
not depend on it.

Persistence: `/sandbox/space` is the per-space volume (home, chats). The rest of the filesystem is the container
layer: it survives stop/start, not a recreate (`deploy/recreate-computers.sh` after an image upgrade).
Note: OpenShell does **not** apply the image `ENV` to exec'd processes; computerd passes `HOME`, `PATH`, `LANG`…
explicitly (`computerd/src/exec.ts` `baseEnv`).

Tests: `computerd/test/integration.sh` and `e2e/infra-smoke.sh` (toolchain, pip/npm/git/Chromium over the
public internet, Playwright MCP, CDP).
