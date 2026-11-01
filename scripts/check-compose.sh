#!/usr/bin/env bash
# Validate release and source definitions without requiring an operator's private .env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/.run"
work=$(mktemp -d "$ROOT/.run/compose-config.XXXXXX")
trap 'rm -rf "$work"' EXIT
for role in single node computers edge; do
  if [ "$role" = single ]; then
    file="$ROOT/deploy/docker-compose.yml"
    example="$ROOT/deploy/.env.example"
  else
    file="$ROOT/deploy/cluster/$role.yml"
    example="$ROOT/deploy/cluster/$role.env.example"
  fi
  if [ "$role" = single ]; then
    cp "$file" "$work/docker-compose.yml"
    (cd "$work" && docker compose --profile '*' config -q)
    echo 'PASS compose config: empty installation with only docker-compose.yml'
  fi
  cp "$example" "$work/.env"
  # Required secrets are throwaway values used for syntax/interpolation checks only.
  sed -i -E 's/^(RUSTFS_SECRET_KEY|COMPUTERD_TOKEN|OPENSHELL_VOLUMES_TOKEN|S3_ACCESS_KEY|S3_SECRET_KEY|SETUP_TOKEN)=$/\1=compose-config-check/' "$work/.env"
  docker compose --project-directory "$work" --env-file "$work/.env" -f "$file" --profile '*' config -q
  printf 'PASS compose config: %s\n' "${file#"$ROOT/"}"
  if [ "$role" = single ]; then
    docker compose --project-directory "$work" --env-file "$work/.env" -f "$file" \
      -f "$ROOT/deploy/docker-compose.build.yml" --profile '*' config -q
    echo 'PASS compose config: deploy/docker-compose.build.yml with release base'
  fi
done
