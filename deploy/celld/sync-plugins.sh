#!/bin/bash
# Read a standard plugin tree once; send its full inventory without exposing the installation token.
set -euo pipefail
umask 077
root=${1:?plugin folder path required}
url=${2:?Worker URL required}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ ! -e "$root" ]; then
  printf '{"mounted":false}' > "$work/request.json"
else
  [ -d "$root" ] && [ ! -L "$root" ] || { echo 'Plugin mount must be a directory' >&2; exit 1; }
  : > "$work/entries"
  for kind in plugins skills mcp; do
    [ -e "$root/$kind" ] || continue
    # A broken inventory must never look like an empty mount.
    [ -d "$root/$kind" ] && [ ! -L "$root/$kind" ] || { echo "Invalid plugin directory: $kind" >&2; exit 1; }
    find "$root/$kind" -mindepth 1 -maxdepth 1 -print0 | sort -z > "$work/paths"
    while IFS= read -r -d '' entry; do
      path="$kind/${entry##*/}"
      case "$kind" in mcp) [[ "$entry" = *.json ]] || continue ;; esac
      problem=''
      if [ -L "$entry" ]; then
        problem=plugin_links_unsupported
      elif [ "$kind" = mcp ] && [ -f "$entry" ]; then
        if ! tar -cz -C "$root/mcp" --transform='s|.*|.mcp.json|' -- "${entry##*/}" | head -c 10485761 > "$work/archive"; then problem=plugin_too_large; fi
      elif [ "$kind" != mcp ] && [ -d "$entry" ]; then
        # Cap compressed input at the same 10 MiB limit as uploads.
        if ! tar -cz -C "$entry" . | head -c 10485761 > "$work/archive"; then problem=plugin_too_large; fi
      else
        problem=invalid_plugin_input
      fi
      if [ -z "$problem" ] && [ "$(wc -c < "$work/archive")" -gt 10485760 ]; then problem=plugin_too_large; fi
      if [ -n "$problem" ]; then
        jq -cn --arg path "$path" --arg problem "$problem" '{path:$path,problem:$problem}' >> "$work/entries"
      else
        base64 -w0 "$work/archive" > "$work/base64"
        jq -cn --arg path "$path" --rawfile archive "$work/base64" '{path:$path,archive:$archive}' >> "$work/entries"
      fi
      [ "$(wc -c < "$work/entries")" -le 65000000 ] || { echo 'Plugin inventory exceeds 64 MiB' >&2; exit 1; }
    done < "$work/paths"
  done
  jq -sc '{mounted:true,entries:.}' "$work/entries" > "$work/request.json"
fi
# curl's config keeps the token out of argv and logs. Tokens are generated installation secrets.
printf 'header = "Authorization: Bearer %s"\n' "${COMPUTERD_TOKEN:?installation token required}" > "$work/curl.conf"
curl --fail --silent --show-error --config "$work/curl.conf" --connect-timeout 3 --max-time 90 \
  --retry 20 --retry-connrefused --retry-delay 1 --retry-max-time 60 \
  -H 'Content-Type: application/json' --data-binary @"$work/request.json" \
  "$url/api/baskule/plugins/folder-sync" > "$work/response.json"
jq -r '.folder.problems[]? | "Plugin folder: \(.path): \(.message)"' "$work/response.json" >&2
