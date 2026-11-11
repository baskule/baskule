#!/usr/bin/env bash
# Native launcher for Baskule's patched runtime. Callers may override CELLD_BIN.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export TMPDIR="$ROOT/.run/celld-tmp"
mkdir -p "$TMPDIR" "$ROOT/.run/celld-runtime"
runtime_key=$(cd "$ROOT" && sha256sum deploy/celld/Dockerfile deploy/celld/patches/*.patch deploy/celld/tests/*.rs | sha256sum | cut -d' ' -f1)
runtime_dir="$ROOT/.run/celld-runtime/$runtime_key"
if [[ ! -x "$runtime_dir/celld" ]]; then
  (
    flock 9
    [[ ! -x "$runtime_dir/celld" ]] || exit 0
    command -v docker >/dev/null || { echo 'Baskule requires its patched celld. Install Docker or set CELLD_BIN to a compatible binary.' >&2; exit 1; }
    image="baskule-celld:dev-${runtime_key:0:16}"
    echo 'Building the pinned Baskule runtime (cached for subsequent launches).' >&2
    docker build --target source -f "$ROOT/deploy/celld/Dockerfile" -t "$image" "$ROOT" >&2
    container=$(docker create "$image")
    trap 'docker rm "$container" >/dev/null' EXIT
    mkdir -p "$runtime_dir"
    docker cp "$container:/usr/local/bin/celld" "$runtime_dir/celld.pending" >/dev/null
    chmod 755 "$runtime_dir/celld.pending"
    mv "$runtime_dir/celld.pending" "$runtime_dir/celld"
  ) 9>"$ROOT/.run/celld-runtime/build.lock"
fi
exec "$runtime_dir/celld" "$@"
