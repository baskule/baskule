#!/usr/bin/env bash
set -euo pipefail

if [[ $GITHUB_EVENT_NAME == workflow_dispatch && $GITHUB_REF == refs/heads/main ]]; then
  exit 0
fi
if [[ ${SIGN_ALL:-false} == true || $GITHUB_EVENT_NAME != push || $GITHUB_REF != refs/tags/v* ]]; then
  echo 'Signing requires a main-branch dispatch or a macOS release tag on main.' >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/ci/native-version.sh"
[[ ${GITHUB_REF#refs/tags/v} == "$(<"$ROOT/VERSION")" && $NATIVE_VERSION == "$(<"$ROOT/VERSION")" ]] || {
  echo 'Release tag and package version must match VERSION.' >&2
  exit 1
}
git merge-base --is-ancestor HEAD refs/remotes/origin/main || {
  echo 'Release tag must identify a commit on main.' >&2
  exit 1
}
