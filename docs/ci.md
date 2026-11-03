# Hosted checks and artifact builds

The public repository uses standard GitHub-hosted runners. No self-hosted runner, Blacksmith runner or Expo Cloud service is required by these workflows. Deployment to an existing installation is separate.

## Pull requests and main

`CI` runs on pull requests to `main`, pushes to `main`, and manual dispatch without inputs. It has three jobs, which run in parallel:

- `Checks` runs the harness, root/web/mobile/shared typechecks, and desktop checks.
- `Tests` runs platform, Baskule server, hosted-web unit, and shared client package tests.
- `Mobile tests` runs the mobile unit/React tests, the longest suite, on its own runner.

Each suite has its own step. Once setup succeeds, later suites still run after an earlier failure unless the run is cancelled. `CI required` succeeds only when all three jobs succeed. The platform, server, web, mobile, and shared Vitest commands use up to four workers, one per hosted-runner vCPU.

All jobs restore pinned tools and package stores using the same key. Only `Checks` saves a missing key, after installation. PR runs can reuse the default branch's cache. Dependency installation still uses frozen lockfiles.

Routine CI produces no distributable packages and uploads failed suite logs and setup diagnostics. `Checks` and `Tests` build the small SpaceCell bundle because root typechecks and platform tests import it. Hosted-web builds and browser journeys run in the full factory, alongside image and native packaging.

Mobile component tests use the existing mocked native test environment. They do not establish device acceptance. Manual CI also retains setup diagnostics. CI disables remote evidence lookup and recording; it never pushes evidence refs or reads deployment configuration.

```sh
gh workflow run ci.yml --repo baskule/baskule --ref main
```

## Verify the complete factory

For local role and installation checks, use [released installation verification](release-install-verification.md).

Run `Release factory` manually to build and check a candidate without publishing a GitHub release:

```sh
gh workflow run release.yml --repo baskule/baskule --ref main \
  -f verify_only=true -f include_native=true
```

Manual factory runs also post a `Release factory` commit status, linking the candidate to the full run. [GitHub excludes workflow-dispatch job checks from PR checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks). This status is separate from the routine `CI required` gate.

Computer, computerd and OpenShell build in `backend-runtime` after version and source-CI validation, alongside Linux packaging. They need no translated catalogs or Linux artifacts. A separate `hosted-web` job builds and verifies the web bundle once. Final `backend-build` waits for that bundle and the runtime images; it does not wait for desktop packaging. Packaging copies the runtime image archives byte for byte and adds celld. Linux apps also retains the same verified web archive. The build critical path is the longer of runtime images and hosted web, followed by celld packaging and the slowest verification shard.

The release factory builds `backend-<version>` once, then downloads the same archive artifact into isolated GitHub-hosted runners. Each consumer checks `SHA256SUMS`, loads the three published image archives, checks their IDs against `images.txt`, and restores the packaged SpaceCell bundle. Install checks use the packaged Compose assets through `BASKULE_INSTALL_ASSETS`, without checkout mounts or regenerated operator files.

The `backend` job gates publishing and the manual factory status. It requires the build, every component, journey and install shard, upstream server and web suites, and `CI required` on the exact source SHA. A failed, skipped or cancelled dependency fails the gate. Run ordinary CI before dispatching a factory for a temporary source commit.

Ordinary CI already covers lint, feature-map coverage, harness tests, Baskule unit tests and typechecks in `Checks`, `Tests` and `Mobile tests`. Hosted web covers the web component; Linux apps covers desktop checks and verifies the packaged AppImage. Release retains Worker, SpaceCell, computerd, agent and platform feature contracts once each. Upstream server and web suites run on separate runners while packaging runs.

`scripts/check release:journeys --shard N/M` uses Playwright to partition individual journey tests across runners, grouped by stack profile. Each runner keeps one worker to protect shared stack state. Uncovered custom commands are assigned once by feature. The planner removes only declared component commands covered by the release jobs and desktop checks covered by Linux apps. Full components cover named selections. Unknown commands remain in the plan, and owner-run deployed checks remain excluded. Normal `feature:<name>` checks still run all their declared checks. Local `release` still runs its unit and component tiers, then uses the same deduplicated feature plan.

BuildKit exports image layers to Actions cache with separate scopes for computer, computerd, celld, build environment, supervisor, sandbox and gateway. Native Cargo uses every runner core. The native cache contains final release binaries with a source marker, keyed by all vendored source, lockfile, toolchain environment and build script inputs. Full native dependency targets exceed the repository cache quota and stay job-local. A native source change requires a cold compile; unchanged source can reuse verified build outputs. No cache is a verification result. Every release still exercises the resulting archives.

Run the verify-only factory on `main` before tagging to populate caches visible to future release tags. GitHub scopes caches by ref: temporary-branch and tag-only caches do not warm unrelated future tags. The first run populates caches and builds cold. Image export, transfer and Docker-in-Docker startup remain on the critical path after a warm build.

App installers remain GitHub release assets. Settings → Desktop app derives its download links from the running `/version.json`; the current list offers Linux x64, with other platforms added when their installable assets are published. No app archives or download manifest are embedded in celld.

Verified image archives and checksums pass to a separate publish job after backend, Linux app, and requested native
checks pass. Only that job holds `packages: write`. Tag pushes or manual runs with `verify_only=false` publish the
the seven images and the OCI chart listed below. The Compose gateway still bundles the computer, supervisor, and
sandbox images; Kubernetes pulls them from GHCR. Publication skips existing tags whose contents match, refuses
differing ones, and fails on registry authentication or transport errors.
Verification-only runs never log in or push, including manual runs on tag refs.

The native workflow compiles Android arm64, an iOS simulator app, macOS arm64/x64 and Windows x64. Windows packaging executes the existing native-load and server-archive probes. iOS includes a simulator install/launch smoke. Android does not add an emulator lane. Optional upstream Windows package diagnostics remain manual.

Each artifact includes checksums and verification/signing status. Android's default release build uses a debug certificate; desktop output is unsigned by default; the iOS simulator ZIP is not an installable iPhone IPA. These outputs prove the named build and smoke checks, not store readiness or complete native product acceptance.

## Tags and releases

`VERSION` is the source version (currently `0.5.0`). PRs and ordinary `main` pushes run only routine CI. A version tag such as `v0.5.0` starts the full release factory; its version must match `VERSION`. Tag only a commit on which `CI required` has passed: the factory checks it once and does not wait. Its first build stage generates missing translations with the `release` environment's `TRANSLATION_API_KEY` (restricted to `v*` tags) and shares them with every build; see [localization](localization.md). The draft GitHub release waits for backend, Linux apps and native builds to succeed. It attaches the standalone Compose file and env example, the three cluster role files and their examples, checksums, and built packages. Images use version tags; Compose retains digest pins for third-party images. This path does not deploy an installation or submit apps to stores. A manual verification run creates no release and publishes no images. Publishing a manual draft requires `verify_only=false`. A manual version override can be supplied for a candidate; otherwise the factory reads `VERSION`.

Versions and source revisions are recorded with the outputs. Use a versioned tag for an intended release. Local desktop and mobile builds also default to `VERSION`; `BASKULE_VERSION` and `T3CODE_MOBILE_VERSION` respectively override it. Standalone native workflow dispatches default to `VERSION`.

## Production signing

Signing is a separate, explicit native-workflow dispatch from the default branch. Configure the `native-release` GitHub environment with required reviewers and deployment branch restrictions before adding owner credentials. The unsigned `native-ci` environment needs no credentials. Missing signing inputs fail a requested signed build.

Android needs an owner keystore and its passwords/alias. macOS needs Apple signing/notarization credentials, an owned team/profile and the relying-party domains required by the inherited signing contract. Windows uses the inherited Azure Trusted Signing provider. Enter credentials through the supported secret channel and GitHub environment secrets; never commit signing files or paste credentials into logs.

iOS device archives, provisioning, TestFlight and App Store submission require their own owner configuration. The current iOS lane verifies the simulator build only.

## Inspect evidence

Use a run's job logs and artifacts to inspect failures, checksums, package status and source provenance. Classify a failure before rerunning only the affected jobs. Keep package/browser/unit evidence distinct from physical-device acceptance. Verification artifacts are retained for one day; a verified GitHub release is the durable distribution record.

## First image release

The owner must enable Actions package publishing and allow `GITHUB_TOKEN` to write packages for this repository.
After the first publishing run, make these GHCR packages public once in each
package's settings: `baskule-celld`, `baskule-computerd`, `baskule-openshell-gateway`,
`baskule-openshell-kubernetes`, `baskule-computer`, `baskule-openshell-supervisor`,
`baskule-openshell-sandbox`, and the OCI chart `charts/baskule`. The workflow links
their source to this repository. The separate `public-packages` job checks anonymous
pulls and can be rerun after changing visibility **within 24 hours**, while the
backend Actions artifact is retained; it never republishes artifacts.
A visibility failure does not block draft creation. Do not publish the draft until
this job passes. To check downloaded backend artifacts manually, run
`bash scripts/ci/check-public-images.sh artifacts/backend`. Check the draft's Compose assets and image tags before publishing the draft.
Version tags identify one release; do not replace a published tag with different image contents. A verification-only
run checks builds and local behavior without proving GHCR visibility or anonymous downloads.

After that 24-hour window, download the draft release's
`backend-<v>-metadata.tar.gz` and release `SHA256SUMS` with an authenticated account.
Verify the metadata archive against that checksum list, then extract it to a private
scratch directory. It contains `images.txt` and the chart, so run the same
`check-public-images.sh` command against that extracted directory. No image archives
or republishing are needed for this visibility check.

`images.txt` records each saved image's config digest, independent of Docker's image
store (`docker inspect .Id` can be an OCI index digest). Publication follows the
linux/amd64 manifest in an index, skips existing matching config/chart-layer digests,
and refuses differing artifacts before pushing. Rerun a failed publish job to resume
a partial push without replacing published contents.
Resume within the backend artifact's 24-hour retention. A later factory run rebuilds
images with different config digests, so publication of that version is refused
and the release needs a new version.
