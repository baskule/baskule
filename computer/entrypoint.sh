#!/usr/bin/env bash
# baskule-computer entrypoint. Runs at every container start (first boot on an empty /data volume and every wake).
#  1. (root) make sure /data and the chats root are owned by agent, then re-exec as agent (UID 1000).
#  2. (agent) create the persistent directory layout idempotently.
#  3. generate OpenCode's native config from env (overwritten at every start).
#  4. set the service password and exec `opencode serve --service`.
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  mkdir -p /data/home "$BASKULE_CHATS_DIR"
  for d in /data /data/home "$BASKULE_CHATS_DIR"; do [ "$(stat -c %u:%g "$d")" = 1000:1000 ] || chown 1000:1000 "$d"; done
  export USER=agent LOGNAME=agent
  exec setpriv --reuid=1000 --regid=1000 --init-groups -- "$0" "$@"
fi

die() { echo "baskule-computer: $*" >&2; exit 1; }
: "${BASKULE_OPENCODE_PASSWORD:?BASKULE_OPENCODE_PASSWORD is required}"
: "${BASKULE_LLM_BASE_URL:?BASKULE_LLM_BASE_URL is required}"
: "${BASKULE_LLM_MODEL:?BASKULE_LLM_MODEL is required}"
[ -n "${BASKULE_LLM_API_KEY:-}" ] || echo "baskule-computer: warning: BASKULE_LLM_API_KEY is empty" >&2

# --- 2. persistent layout (idempotent) --------------------------------------------------------------------
mkdir -p "$HOME/.local/bin" "$BASKULE_CHATS_DIR" \
  "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
if [ ! -f "$HOME/.bashrc" ]; then
  cp /etc/skel/.bashrc /etc/skel/.profile "$HOME/" 2>/dev/null || true
  git config --global user.name "Baskule Agent"
  git config --global user.email "agent@baskule.local"
  git config --global init.defaultBranch main
fi
# Default Python venv on the volume: `pip install x` persists across restarts and image upgrades.
if [ ! -x "$HOME/.venv/bin/python" ]; then
  python3 -m venv --system-site-packages "$HOME/.venv" || die "venv creation failed"
fi

# --- 3. OpenCode config -----------------------------------------------------------------------------------
node /opt/baskule/gen-config.mjs > "$XDG_CONFIG_HOME/opencode/opencode.jsonc.tmp" || die "config generation failed"
mv "$XDG_CONFIG_HOME/opencode/opencode.jsonc.tmp" "$XDG_CONFIG_HOME/opencode/opencode.jsonc"

# --- 4. service password + server -------------------------------------------------------------------------
# In --service mode the password comes from service.json (`opencode service set password`), not from the env.
opencode service set password "$BASKULE_OPENCODE_PASSWORD" >/dev/null
chmod 600 "$XDG_CONFIG_HOME/opencode/service.json" 2>/dev/null || true
unset BASKULE_OPENCODE_PASSWORD OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD

cd "$BASKULE_CHATS_DIR"
echo "baskule-computer: opencode $(cat /opt/opencode/VERSION) serving on :${BASKULE_OPENCODE_PORT:-4096} (model ${BASKULE_LLM_MODEL})" >&2
exec opencode serve --service --hostname 0.0.0.0 --port "${BASKULE_OPENCODE_PORT:-4096}" \
  --print-logs --log-level "${BASKULE_LOG_LEVEL:-warn}"
