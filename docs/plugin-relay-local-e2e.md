# Verify plugin sign-in with the real local relay

Use the private relay Worker and a disposable OAuth vendor to check the
[sign-in contract](plugin-sign-in-relay.md) against the full Baskule stack.
This check needs the private relay checkout, so it is not a public journey test.
The local driver is `.run/plugin-relay-local-e2e.mjs`; evidence is under
`.run/evidence/plugin-relay/e2e/`. Both paths are ignored by Git.

## Run the local proof

1. Set `RELAY_REPO` to a local checkout of the relay at `b10387b` with its pinned dependencies installed.
2. Run `scripts/worktree setup`, source `scripts/env.sh`, and run `scripts/worktree runtime`.
3. Stop any stack you previously started in this worktree with `scripts/stack down`.
4. To use fresh data and retain prior worlds, move the stopped `.run/stack` directory to an unused path under `.run/`.
5. Run the driver:

   ```sh
   BASKULE_STACK_PROXY=0 RELAY_REPO="$RELAY_REPO" node .run/plugin-relay-local-e2e.mjs
   ```

The driver starts the real Worker through `wrangler dev --local`. Its generated
configuration uses an HTTP loopback `PUBLIC_URL`, a fresh signing key, and
`EXTRA_VENDORS` for `relayfixture`. The vendor is
`platform/test/fixtures/oauth.mjs`, with DCR disabled, a static public client ID,
and a fresh secret that every vendor token request must supply. No Cloudflare
account or real vendor account is used.

The full Baskule stack uses the fake LLM. Direct loopback avoids dependence on
the host's port 443 and TLS proxy. Helm continues to require HTTPS for deployed
relay URLs.

## Use a build-entry catalog fixture

Custom plugin creation assigns a UUID to both `id` and `vendor`; updates preserve
the vendor. Relay setup requires a catalog vendor with `signIn.relay`, and relay
IDs cannot be UUIDs. A custom `oauth.staticClient` plugin therefore cannot use
relay mode through the current API.

The driver generates `.run/plugin-relay-entry.mjs` and selects it with the existing
`BASKULE_ENTRY` build option. This entry adds one vendor and service to the
in-memory catalog before exporting the real Worker, ControlCell, and SpaceCell.
The service uses the same static-client OAuth recipe as a catalog integration.
The browser adds the same fixture entries to the served catalog metadata chunk
through a Playwright route. It uses the real catalog setup dialog; API requests
and OAuth navigation are not intercepted. No production source, test flag, probe
route, database row, or runtime class is replaced. The relay's own registry uses its existing loopback-only
`EXTRA_VENDORS` option.

## Inspect the evidence

The driver asserts these results and writes timestamped steps to `steps.json`:

1. The administrator chooses **Baskule sign-in** in the setup dialog.
2. The member starts a connection and sees the real relay confirmation page.
3. **Continue** auto-approves at the fake vendor and returns to a ready account.
   The relay sets and consumes its browser-binding cookie.
4. A fake-LLM `[[fake:tool *fixture_lookup {}]]` call reads the protected MCP resource.
   The first call uses its original access token. The driver waits for the advertised
   one-minute expiry, then a separate call refreshes through the relay. Refreshed
   tokens last one second so the outage also requires refresh. No DCR request occurs.
5. With the relay stopped, a tool call reports unavailable and makes no vendor
   call. The account stays ready rather than requiring reconnection.
6. After the relay restarts, another tool call succeeds using the retained grant.

Screenshots `01` through `06`, `relay.log`, `vendor-summary.json`, `doctor.log`,
and the stack startup and shutdown logs accompany the assertions. The driver
closes Chromium, stops the relay and stack, and closes both fake-vendor servers
in `finally`. `stack-after.json` records the stopped stack. Fresh disposable
accounts remain in the stopped local stack for inspection.

The separate public journey is run with:

```sh
BASKULE_STACK_PROXY=0 scripts/check journey:plugins.spec.mjs
```

The filename filter also selects the adjacent desktop folder-plugin journey.
Its log and retained Playwright results are under `.run/evidence/plugin-relay/`.
Fake-vendor success proves protocol wiring; real vendor consent and app approval
remain separate acceptance checks.

The verified 2026-11-05 run recorded 1 authorization-code exchange, 2 refreshes,
and 3 successful protected MCP calls, with zero registrations. The first tool
call used the original access token; the next call refreshed after its advertised
expiry. Every vendor token request carried the relay client ID and secret. The
stopped-relay call returned unavailable and made no vendor call; recovery reused
the existing grant.
