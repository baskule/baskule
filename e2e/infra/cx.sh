#!/bin/bash
# cx.sh <spaceId> <bash script>: run a script in the space's computer through computerd (inside baskule-net).
# Prints decoded stdout+stderr; exits with the remote exit code.
body=$(jq -n --arg s "$2" '{argv: ["bash", "-c", $s], cwd: "/sandbox/space"}')
out=$(curl -sN -X POST -H "Authorization: Bearer $COMPUTERD_TOKEN" -H 'content-type: application/json' \
  "http://baskule-computerd:47094/v1/spaces/$1/exec" -d "$body" |
  jq -rj 'if .t == "o" or .t == "e" then (.d | @base64d) elif .t == "x" then "\n__EXIT__=\(.code)\n" else "\n__ERR__=\(.msg)\n" end')
printf '%s\n' "$out" | grep -v '^__EXIT__=' | grep -v '^__ERR__='
code=$(printf '%s\n' "$out" | sed -n 's/^__EXIT__=//p' | tail -1)
[ -n "$code" ] || { printf '%s\n' "$out" | grep '^__ERR__=' >&2; exit 125; }
exit "$code"
