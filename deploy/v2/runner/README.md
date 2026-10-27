# Prepare optional deployment and CI runners

Runner automation is deferred for the public repository. These scripts are host setup tools for a reviewed,
operator-managed installation. They do not register or modify a host until an operator runs them.

## Configure staging isolation

Set `BASKULE_STAGING_PUBLIC_IP` to the staging host's actual public IPv4 address when running `install.sh` or
`install-ci-rootless.sh prepare`. The installers require this value and append its `/32` denial to the installed,
root-owned systemd policy. The committed policies already deny private networks, tailnet ranges, and metadata.
Host-specific addresses stay outside source control.

The boundary check requires these environment settings:

| Setting | Value |
| --- | --- |
| `BASKULE_STAGING_ADDRESS` | Actual staging IPv4 address reachable from the CI host before isolation. Required; loopback and the unspecified address are rejected. |
| `BASKULE_STAGING_PORT` | Application port. Defaults to `47090`. |

For future GitHub Actions setup, create a repository variable named `BASKULE_STAGING_ADDRESS` and pass it to the
boundary job as an environment variable. Pass `BASKULE_STAGING_PORT` too if the port differs from `47090`.
Run the check inside the isolated runner account. A loopback listener does not prove staging isolation.

## Review the deployment gate

`deploy.py` fetches only canonical `main` from `git@github.com:baskule/baskule.git` and rejects other requested
commits. Its checkout, read-only deploy key, known hosts, and build caches live under root-owned `/opt/baskule`.
`install.sh` registers `baskule-contabo-deploy` for `baskule/baskule` and installs
`actions.runner.baskule-baskule.baskule-contabo-deploy.service`.

`install-ci-rootless.sh` expects the CI runner services
`actions.runner.baskule-baskule.baskule-contabo-ci{,-2,-3}.service`. Its `prepare` step installs rootless Docker
and policy files. Drain and stop those workers before `activate`, which restarts their user manager and services.

Persistent workers share an account and writable caches. Rootless Docker limits Docker privileges but does not
isolate untrusted public contributions from later jobs. Use disposable workers or equivalent job isolation before
accepting arbitrary public code. Runner labels do not provide that isolation.
