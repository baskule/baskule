#!/usr/bin/env bash
# Create deploy/.env from .env.example with fresh random secrets (never overwrites an existing .env).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -e "$DEPLOY_DIR/.env" ] && { log ".env exists; not touching it"; exit 0; }
umask 077
rnd() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
sed -e "s/^RUSTFS_SECRET_KEY=$/RUSTFS_SECRET_KEY=$(rnd)/" \
    -e "s/^COMPUTERD_TOKEN=$/COMPUTERD_TOKEN=$(rnd)/" \
    -e "s/^OPENSHELL_VOLUMES_TOKEN=$/OPENSHELL_VOLUMES_TOKEN=$(rnd)/" \
    "$DEPLOY_DIR/.env.example" > "$DEPLOY_DIR/.env"
log "wrote $DEPLOY_DIR/.env (mode 600). Set ADMIN_EMAIL/ADMIN_PASSWORD before ./up.sh, then configure AI in Admin → Settings"
