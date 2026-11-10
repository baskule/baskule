# Hosted checks and artifact builds

Workflows run on standard GitHub-hosted runners. Deployment to an existing installation is separate.

## Pull requests and main

`CI` runs on pull requests to `main`, pushes to `main`, and manual dispatch without inputs. It has three jobs, which run in parallel:

- `Checks` runs the harness, root/web/mobile/shared typechecks, and desktop checks.
- `Tests` runs platform, Baskule server, hosted-web unit, and shared client package tests.
- `Mobile tests` runs the mobile unit/React tests, the longest suite, on its own runner.

Each suite has its own step. Once setup succeeds, later suites still run after an earlier failure unless the run is canceled. `CI required` succeeds only when all three jobs succeed. The platform, server, web, mobile, and shared Vitest commands use up to four workers, one per hosted-runner vCPU.

All jobs restore pinned tools and package stores using the same key. Only `Checks` saves a missing key, after installation. PR runs can reuse the default branch's cache. Dependency installation still uses frozen lockfiles.

Routine CI produces no distributable packages and uploads failed suite logs and setup diagnostics. `Checks` and `Tests` build the small SpaceCell bundle because root typechecks and platform tests import it. Hosted-web builds and browser journeys run in the full factory, alongside image and native packaging.

Mobile component tests use the existing mocked native test environment. They do not establish device acceptance. Manual CI also retains setup diagnostics. CI disables remote evidence lookup and recording; it never pushes evidence refs or reads deployment configuration.

```sh
gh workflow run ci.yml --repo baskule/baskule --ref main
```

## Independent entry points

Each workflow can be launched on its own; no earlier Actions run is required.

| Workflow | What one launch does |
| --- | --- |
| `ci.yml` | Run routine checks and unit tests |
| `backend.yml` | Build runtime images and hosted web, package the backend, then run component, journey and installation checks |
| `native.yml` | Build and check the selected Android, iOS simulator or desktop platforms |
| `release.yml` | Run CI, backend and all native builds; check upstream and Linux desktop; assemble all release assets |

Backend verification uses committed translations and `VERSION`. It needs no desktop build, translation artifact or previous CI run. It also runs on pull requests that change its workflow or `scripts/ci/backend.sh` so changes to its orchestration are exercised independently.

```sh
gh workflow run backend.yml --repo baskule/baskule --ref main
gh workflow run native.yml --repo baskule/baskule --ref main -f platform=android
```

Release reuses the same CI, backend and native workflows through `workflow_call`. Its internal translation, upstream, Linux, assembly and publication jobs stay together in `release.yml`. Release supplies the shared translation artifact to backend and native builds; standalone runs use their source catalogs. The backend workflow owns its runtime and web prerequisites and exchanges their artifacts within the same run. Linux packaging builds its own desktop renderer and runs alongside backend verification.

Manual release runs always verify and assemble the complete candidate. Only a version-tag push publishes. There are no partial-release or publication mode switches.

## Verify the complete factory

For local role and installation checks, use [released installation verification](release-install-verification.md).

Run `Release factory` manually to build and check a candidate without publishing a GitHub release:

```sh
gh workflow run release.yml --repo baskule/baskule --ref main
```

Manual factory runs also post a `Release factory` commit status, linking the candidate to the full run. [GitHub excludes workflow-dispatch job checks from PR checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks). This status is separate from the routine `CI required` gate.

Within backend verification, computer and computerd archives build alongside hosted web. Backend packaging waits for both, copies the runtime archives byte for byte, and adds celld. All backend check shards consume that one packaged result. Native builds, upstream suites and routine CI run alongside the backend workflow.

The release factory builds `backend-<version>` once, then downloads the same archive artifact into isolated GitHub-hosted runners. Each consumer checks `SHA256SUMS`, loads the three published image archives, checks their IDs against `images.txt`, and restores the packaged SpaceCell bundle. Install checks use the packaged Compose assets through `BASKULE_INSTALL_ASSETS`, without checkout mounts or regenerated operator files.

The `verified` job gates release assembly and publication. It requires backend verification, upstream server and web suites, Linux and all native packages, and routine CI on the same source. A failed, skipped or canceled required dependency fails the gate. Release runs CI itself rather than requiring a previous passing run.

Ordinary CI already covers lint, feature-map coverage, harness tests, Baskule unit tests and typechecks in `Checks`, `Tests` and `Mobile tests`. Hosted web covers the web component; Linux apps covers desktop checks and verifies the packaged AppImage. Release retains Worker, SpaceCell, computerd, agent and platform feature contracts once each. Upstream server and web suites run on separate runners while packaging runs.

`scripts/check release:journeys --shard N/M` uses Playwright to partition individual journey tests across runners, grouped by stack profile. Each runner keeps one worker to protect shared stack state. The runner stops the stack after each profile group and uncovered custom check, including failures, before another profile can start. Stack data is retained until the CI driver cleans up its disposable runner. Uncovered custom commands are assigned once by feature. The planner removes only declared component commands covered by the release jobs and desktop checks covered by Linux apps. Full components cover named selections. Unknown commands remain in the plan, and live-installation checks remain excluded. Normal `feature:<name>` checks still run all their declared checks. Local `release` still runs its unit and component tiers, then uses the same deduplicated feature plan.

Build caches accelerate packaging but do not replace verification. Every release exercises the resulting archives.

Run the manual factory on `main` before tagging to populate caches visible to future release tags. GitHub scopes caches by ref: temporary-branch and tag-only caches do not warm unrelated future tags. The first run populates caches and builds cold. Image export, transfer and container startup remain on the critical path after a warm build.

App installers remain GitHub release assets. Settings → Desktop app derives its download links from the running `/version.json`; the current list offers Linux x64, with other platforms added when their installable assets are published. No app archives or download manifest are embedded in celld.

Verified image archives and checksums pass to a separate publish job after every check and final asset assembly passes. Only that job requests `packages: write`. Version-tag pushes publish the images and OCI chart. Compose and Kubernetes pull the computer image from GHCR. Publication skips existing tags whose contents match, refuses differing ones, and fails on registry authentication or transport errors.

Manual runs never log in to GHCR, push packages, or create a GitHub release, including manual runs on tag refs. They execute the same checksum validation and asset assembly as publishing runs and retain `release-assets-<version>` as an Actions artifact.

The native workflow compiles Android arm64, an iOS simulator app, macOS arm64/x64 and Windows x64. Windows packaging executes the existing native-load and server-archive probes. iOS includes a simulator install/launch smoke. Android does not add an emulator lane. Optional upstream Windows package diagnostics remain manual.

Each artifact includes checksums and verification/signing status. Android's default release build uses a debug certificate; standalone desktop verification output is unsigned by default; production macOS output is signed and notarized; the iOS simulator ZIP is not an installable iPhone IPA. These outputs prove the named build and smoke checks, not store readiness or complete native product acceptance.

## Tags and releases

`VERSION` is the source version (currently `0.5.2`). PRs and ordinary `main` pushes run only routine CI. A version tag such as `v0.5.2` starts the full release factory; its version must match `VERSION`. The factory runs routine CI on the tagged source alongside its other checks. Its first build stage generates missing translations with the `release` environment's `TRANSLATION_API_KEY` (restricted to `v*` tags) and shares them with every build; see [localization](localization.md). The draft GitHub release waits for backend, Linux apps and native builds to succeed. It attaches the standalone Compose file and env example, the Helm chart, checksums, the backend metadata archive, and the app installers and update manifests; image archives and the iOS Simulator build stay CI artifacts. Images use version tags; Compose retains digest pins for third-party images. Once `public-packages` confirms anonymous image pulls, the `release` job publishes the draft as the latest release. This path does not deploy an installation or submit apps to stores. A manual verification run creates no release and publishes no images. Manual runs read `VERSION` and cannot publish.

Versions and source revisions are recorded with the outputs. Use a versioned tag for an intended release. Local desktop and mobile builds also default to `VERSION`; `BASKULE_VERSION` and `T3CODE_MOBILE_VERSION` respectively override it. Standalone native workflow dispatches default to `VERSION`.

## Production signing

Production release runs (version-tag pushes) always build both macOS architectures with Developer ID signing and notarization, independently of Android and Windows signing. Verification-only factory runs remain unsigned. For an explicit signed check, dispatch Native clients from `main` with `platform=desktop` and `sign_macos=true`; `sign=true` retains the all-platform signing option. Do not dispatch a signed build until credentials and local signing validation are ready.

Configure `native-release` before adding credentials: require a maintainer reviewer, disable administrator bypass, and allow only branch `main` and tag pattern `v*` (separate branch/tag rules). The source-validation job runs before signing jobs enter this environment: a signing dispatch must use `main`; a tag must match `VERSION`, be valid SemVer, and point to a commit on `origin/main`. Reviewers must also verify the source and workflow before releasing credentials; the tag pattern alone cannot enforce ancestry. The unsigned `native-ci` environment needs no credentials.

Store these macOS secrets in `native-release`:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application certificate and private key exported as a `.p12` |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_TEAM_ID` | Expected 10-character Developer Team ID; checked against both packaged apps |
| `APPLE_ID` | Apple account email for password-based notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple account |

Alternatively, omit the two Apple account secrets and configure `APPLE_API_KEY` (raw `.p8` contents), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. A complete Apple account pair takes precedence if both methods are configured; incomplete credentials fail before packaging. This uses [electron-builder's supported notarization credentials](https://www.electron.build/v26/docs/features/code-signing/notarization/). Never commit signing files or paste credentials into logs.

Baskule's hosted renderer disables Clerk. Ordinary Developer ID signing needs no provisioning profile: the app retains its Electron runtime, camera, and microphone entitlements. Configured passkey builds still require `MACOS_PROVISIONING_PROFILE` (base64-encoded profile) plus the environment variable `MACOS_PASSKEY_RP_DOMAINS` (comma-separated domains the publisher owns and has configured). Those inputs preserve associated-domain and profile-authorized browser passkey/Touch ID entitlements. Do not supply invented domains to satisfy signing. A profile without domain configuration, or domains without a profile, fails instead of silently dropping passkeys.

Before upload, each macOS lane copies the app from its final DMG and extracts its final updater ZIP. Both must pass deep/strict signature verification, Developer ID authority and Team ID checks, notarization-ticket validation, and Gatekeeper assessment. Missing credentials or failed checks block publication; these checks do not replace a launch test on a Mac.

Android needs a publisher-controlled keystore, its passwords, and its alias. Windows uses the inherited Azure Trusted Signing provider. Their signing remains an explicit `sign=true` dispatch from `main`.

iOS device archives, TestFlight and App Store submission need the publisher's Apple provisioning profiles and credentials. The current iOS lane verifies the simulator build only.

## Inspect evidence

The always-running `factory-status` job writes a summary with the source SHA, version, publication status, each component result, and links to the run artifacts and successful release. Manual runs also set the `Release factory` commit status, which requires verification and asset assembly to succeed. Use a run's job logs and artifacts to inspect failures, checksums, package status and source provenance. Release journey traces and screenshots use separate `.run/journeys/results/<profile>/` directories so a later profile cannot erase a previous failure. Classify a failure before rerunning only the affected jobs. Keep package/browser/unit evidence distinct from physical-device acceptance. Verification artifacts are retained for one day; a verified GitHub release is the durable distribution record.

## First image release

Repository administrators must enable Actions package publishing and allow `GITHUB_TOKEN` to write packages for this repository.
After the first publishing run, make these GHCR packages public once in each
package's settings: `baskule-celld`, `baskule-computerd`, `baskule-computer`, and the OCI chart `charts/baskule`. The workflow links
their source to this repository. The separate `public-packages` job checks anonymous
pulls and can be rerun after changing visibility **within 24 hours**, while the
backend Actions artifact is retained; it never republishes artifacts.
A visibility failure does not block draft creation; it keeps the release a draft. After
making the packages public, rerun the failed jobs so `public-packages` and `release` publish it. To check downloaded backend artifacts manually, run
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
