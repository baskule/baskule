#!/bin/sh
# baskule-server entrypoint: render the managed settings, then run the T3 server headless.
set -eu
BASE="${BASKULE_BASE_DIR:-/baskule}"

# T3 only offers the scratch ("No project") root when the base dir is not inside a git work tree.
if git -C "$BASE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "baskule-server: $BASE is inside a git work tree; scratch chats would be disabled" >&2
  exit 1
fi
mkdir -p "$BASE/userdata" "$BASE/scratch"
node /opt/baskule/render-settings.mjs "$BASE/userdata/settings.json"
unset BASKULE_OPENCODE_PASSWORD

cd "$BASE/scratch"
exec node /opt/t3/dist/bin.mjs serve \
  --host 0.0.0.0 --port "${BASKULE_SERVER_PORT:-3773}" --base-dir "$BASE" --no-browser "$@"
