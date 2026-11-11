# celld warm-worker retention

Baskule's container builds celld 0.6.3 from upstream commit
`8702f6d186c77698dbfb30cf29e3b1922a88f008`, with
[`0001-preserve-warm-stateless-worker.patch`](../deploy/celld/patches/0001-preserve-warm-stateless-worker.patch).
The source archive and Rust builder image are checksum-pinned in
[`deploy/celld/Dockerfile`](../deploy/celld/Dockerfile). The official celld runtime
image still supplies system dependencies and license notices.

Upstream's periodic pool maintenance can retire the last stateless isolate when
no JavaScript turns are running. The next request must compile the worker again.
For a large bundled application this can stall both application responses and
node health checks for seconds.

The patch gives the retirement decision a minimum live count. Routine stateless
maintenance preserves one compiled worker per loaded script and current
generation. Extra workers still retire one per maintenance pass. Empty cell
pools still shrink to zero, and superseded generations still retire completely
after their requests and resident cells drain. Admission, pressure handling,
request limits, cell placement, and data formats are unchanged.

The tradeoff is the retained memory of one stateless worker per loaded script
on each node. This is not an unbounded cache. There is no new setting, service,
database migration, or change to T3 Code. A small vendored patch avoids
maintaining a separate celld fork. Remove it when a tested upstream release
provides equivalent behavior.

## Build and verify

```sh
docker build --target source -f deploy/celld/Dockerfile -t baskule-celld:local .
```

The build runs the policy tests and a lifecycle test using real V8 workers before
installing the release binary. They cover the stateless minimum, burst cleanup,
retirement hysteresis, suspended requests, cell residency, empty cell pools,
generation retirement, pressure handling, and the request cap. These focused
tests do not replace upstream's private test suite, which is absent from its
public source snapshot.

Native worktree setup still installs the official celld binary. To exercise the
patched runtime locally, extract it from the built image into this worktree and
set `CELLD_BIN` for the stack and checks:

```sh
mkdir -p .run/patched-celld
container=$(docker create baskule-celld:local)
docker cp "$container:/usr/local/bin/celld" .run/patched-celld/celld
docker rm "$container"
export CELLD_BIN="$PWD/.run/patched-celld/celld"
scripts/worktree runtime
scripts/check space
```

Keep performance samples separate from compilation and other CPU-heavy checks.
Compare direct-node HTML, health checks, and edge responses across several
30-second maintenance intervals. Record errors, memory use, and worker
retirement events as well as latency.

## Deployment

Deployments require the installation operator's authorization. For a runtime-only
update, preserve the installed release's application bundle and replace only
`/usr/local/bin/celld` in its image. Keep the original image available for rollback.
Update one node at a time, allowing its configured graceful shutdown and waiting
for health and application responses before proceeding to its peer. Verify
existing conversations and a new disposable conversation after the rollout.

A local image override must be removed or updated deliberately when installing
a later Baskule release; otherwise it continues selecting the older application
image. Rollback selects the original image and uses the same rolling sequence.
No data rollback is needed because this patch changes no storage format.
