# celld runtime patches

Baskule's container builds celld 0.6.3 from upstream commit
`8702f6d186c77698dbfb30cf29e3b1922a88f008`, with
[`0001-preserve-warm-stateless-worker.patch`](../deploy/celld/patches/0001-preserve-warm-stateless-worker.patch) and
[`0002-lazy-es-modules.patch`](../deploy/celld/patches/0002-lazy-es-modules.patch).
The source archive and Rust builder image are checksum-pinned in
[`deploy/celld/Dockerfile`](../deploy/celld/Dockerfile). The official celld runtime
image still supplies system dependencies and license notices.

## Warm-worker retention

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

## Lazy application modules

Baskule builds `dist/runtime/index.js` and ESM chunks with esbuild splitting.
The entry exports the request handler and small `ControlCell` and `SpaceCell`
facades. On first fetch or alarm, a facade imports its implementation and passes
the original native context and environment to it. It creates no additional
cell, SQL client, or storage namespace. T3 and OpenCode remain in one SpaceCell.

The second celld patch uploads sibling `.js` and `.mjs` files for `no_bundle`
deployments and records their module kind. The runtime retains their source and
compiles each module when a static or dynamic import first reaches it. Previously
sibling modules were compiled eagerly, and ordinary deployments were rebundled
into one file. Splitting only at the esbuild stage would not avoid that work.

Multi-module entries must be named `index.js`, matching celld's existing main
module identity. Keep only runtime files under that directory: discovery is
recursive. Module bytes participate in deployment identity, and imports share
one module instance in each isolate. Text and WASM modules retain their existing
behavior. The manifest requires `es-modules-v1`; older runtimes reject it.

The `baskule` script name, both class names, and `getByName` names are unchanged.
No database migration is needed. Deployments remain atomic bundles of the entry
and all chunks; do not copy only the entry file when publishing release assets.

Baskule's build also excludes OpenCode's disabled models.dev snapshot and provider
adapter loaders outside `BASKULE_AI_PROVIDERS`. It retains supported provider
families and their subpaths, registry keys, tools, plugins, and upstream source
packages. Build guards reject incompatible SDK layouts or catalog settings.
Unused provider callbacks reject explicitly. The real-SDK build tests verify the
retained imports and that accepted admin provider IDs match the package mapping.

## Build and verify

```sh
docker build --target source -f deploy/celld/Dockerfile -t baskule-celld:local .
```

The build runs the policy tests, a lifecycle test using real V8 workers, and
ES-module deployment/import tests before installing the release binary. They cover the stateless minimum, burst cleanup,
retirement hysteresis, suspended requests, cell residency, empty cell pools,
generation retirement, pressure handling, and the request cap. These focused
tests do not replace upstream's private test suite, which is absent from its
public source snapshot. ESM tests cover lazy evaluation, shared module identity,
relative and dynamic imports, builtin namespaces, syntax/evaluation errors, WASM,
module discovery and deployment capability markers.

The native launcher (`scripts/celld.sh`) builds the `source` target on first use
and caches its binary by Dockerfile, patch and test contents. Subsequent launches
reuse it. This requires Docker. `CELLD_BIN` overrides the launcher for a compatible
binary you already built. For example:

```sh
mkdir -p .run/patched-celld
container=$(docker create baskule-celld:local)
docker cp "$container:/usr/local/bin/celld" .run/patched-celld/celld
docker rm "$container"
export CELLD_BIN="$PWD/.run/patched-celld/celld"
scripts/worktree runtime
scripts/check space
```

To inspect bundle composition without putting source paths in the deployed artifact:

```sh
mkdir -p .run/evidence/bundle
BASKULE_MINIFY=1 BASKULE_METAFILE="$PWD/.run/evidence/bundle/meta.json" node platform/scripts/build.mjs
```

Sum the entry's transitive static imports to measure its initial code dependency;
file size alone omits shared chunks. Keep dynamic imports separate and avoid adding
overlapping closures. Total deployment size includes optional chunks that a cell
may never import. Bundle size is not boot latency.

Keep performance samples separate from compilation and other CPU-heavy checks.
Compare direct-node HTML, health checks, and edge responses across several
30-second maintenance intervals. Record errors, memory use, and worker
retirement events as well as latency.

## Deployment

Deployments require the installation operator's authorization. **Upgrade every
node to the patched binary while still serving the old single-file deployment,
then deploy the split application.** An old node cannot adopt an `es-modules-v1`
deployment. Keep the old application artifact and runtime image for rollback.
To roll back to stock celld, first redeploy the old single-file application with
the new runtime, wait for every node to adopt it, then roll back the binaries.
The databases remain in place throughout.

For a runtime-only
update, preserve the installed release's application bundle and replace only
`/usr/local/bin/celld` in its image. Keep the original image available for rollback.
Update one node at a time, allowing its configured graceful shutdown and waiting
for health and application responses before proceeding to its peer. Verify
existing conversations and a new disposable conversation after the rollout.

A local image override must be removed or updated deliberately when installing
a later Baskule release; otherwise it continues selecting the older application
image. Rollback selects the original image and uses the same rolling sequence.
No data rollback is needed because the patches change no database storage format.
