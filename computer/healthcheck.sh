#!/bin/sh
# Docker HEALTHCHECK: OpenCode answers /api/info with HTTP Basic auth (user "opencode").
exec curl -fsS -o /dev/null --max-time 2 -u "opencode:${BASKULE_OPENCODE_PASSWORD}" \
  "http://127.0.0.1:${BASKULE_OPENCODE_PORT:-4096}/api/info"
