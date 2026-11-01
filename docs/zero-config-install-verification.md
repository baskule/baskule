# Verify the zero-config installer

This change starts from `0488654dac99b389ff04d3619faf61866aa6a896` on `t3/release-install`.
Verification uses disposable local Compose projects and the fake LLM. No deployed installation or real model is used.

## Reproduce

Prepare the worktree, build SpaceCell, and select checks:

```sh
scripts/worktree setup
source scripts/env.sh
scripts/worktree runtime
scripts/check plan --base 0488654
scripts/check --base 0488654
scripts/check worker
```

Build a release celld image from the current platform bundle and hosted web output, including the version stamp
created by `scripts/release-backend.sh`. Tag locally built computerd and gateway images from unchanged sources
under the same registry and version. The gateway retags its bundled workload images for that version.
No registry push is needed for these checks.

Run the release verifier with those local tags:

```sh
BASKULE_INSTALL_REGISTRY=ghcr.io/baskule-install-test \
BASKULE_INSTALL_VERSION=zero-config-verify \
BASKULE_INSTALL_EVIDENCE=.run/evidence/zero-config-single \
node e2e/release-install.mjs single

BASKULE_INSTALL_REGISTRY=ghcr.io/baskule-install-test \
BASKULE_INSTALL_VERSION=zero-config-proxy-verify \
BASKULE_INSTALL_EVIDENCE=.run/evidence/zero-config-proxy \
node e2e/release-install.mjs proxy
```

The single-machine verifier begins with only the released compose file in its installation directory. It supplies
the test registry through the command environment; image versions are baked into the generated compose asset.
The default listener is `127.0.0.1:47090`. It reads the setup token from logs and uses curl with an Origin header
and cookie jar to create the first admin and access the authenticated API. It then exercises fake chat and a real
computer command. The update changes the compose file's baked image version. Secret hashes must match across
repeat startup, update, and restore. Backup and restore also check numeric ownership, modes, and user/trusted xattrs.
All projects, fixture containers, and fixture update tags are removed in the verifier's cleanup.

The proxy verifier runs a separate Caddy forwarding fixture. It sends a different Host and HTTPS forwarded scheme
through the bundled edge with no public origin setting. It checks setup, Secure cookies, sign-in, foreign-origin
refusal, and independent sign-in budgets for different forwarded client IPs. Its optional `.env` also overrides the
generated storage and service secrets.

For the local development path:

```sh
BASKULE_STACK_PROXY=0 scripts/stack up --profile light
scripts/stack doctor
BASKULE_STACK_PROXY=0 JOURNEY_PROFILE=light pnpm --dir e2e exec playwright test \
  --config journeys/playwright.config.ts --project desktop \
  --grep 'configured model replaces retired selections'
scripts/stack down
```

Direct loopback mode avoids the local Portless startup timeout observed on this host. The journey creates fresh
people, signs them in, and verifies fake-model streaming and the server-stamped message author.

## Results and limits

- The focused check plan passed, including 147 related platform tests, platform/e2e typechecks, lint, shell/script
  checks, Compose validation, seven jobs tests, and documentation links. Subsequent internal sign-in changes passed
  nine focused tests, typechecking, lint, and the full Worker component check.
- Setup tests cover status, invalid fields, bad tokens, duplicate and simultaneous submissions, SSO without a
  password, a signed-in session, HTTPS cookie attributes without an origin setting, and rate limits.
- Worker integration passed 99 core checks, four persistence checks, signed OIDC GET/form-post callbacks after
  setup, and three anonymous-mode checks.
- Fresh release installation passed setup through curl, session authentication, fake chat, a computer command,
  repeat startup, and compose-file update with unchanged secrets. Restore into empty volumes preserved the original
  secrets hash, chat, computer disk, numeric ownership, modes, and user/trusted xattrs.
- HTTPS proxy verification passed with no public origin setting, including Secure cookies, foreign-origin refusal,
  per-client rate limits, and optional `.env` secret overrides.
- The development API journey passed on the final build. A separate browser check signed in through the visible
  login form, and the browser provider-switch journey passed after Docker activity stopped.
- Earlier browser provider-switch attempts encountered Chromium `ERR_NETWORK_CHANGED` failures while Docker
  interfaces changed, before the composer loaded. Failure traces remain under `.run/evidence/zero-config-dev/`.
- No public release download/pull, new web setup screen, or live cluster rollout was exercised. The setup screen is
  implemented separately against the unchanged API contract. Cluster Compose validation and real SSO setup passed.

Private commands, logs, traces, cookie jars, archives, and generated credentials stay under ignored `.run/`.
The cookie configuration regression found by the proxy check and the native invitation sign-in regression found
by Worker integration were fixed and covered by tests. No independent review round was run by this implementation
sub-agent; the lead retains the review and merge steps.

Evidence locations for this run:

- `.run/evidence/zero-config-single-rerun/results.log`
- `.run/evidence/zero-config-proxy-fixed/results.log`
- `.run/evidence/zero-config-checks/` for focused checks, Worker integration, and development checks
- `.run/evidence/zero-config-dev/` for browser screenshots and failure traces
