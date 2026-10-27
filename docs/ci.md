# Hosted checks and artifact builds

The public repository uses standard GitHub-hosted runners. No self-hosted runner, Blacksmith runner or Expo Cloud service is required by these workflows. Deployment to an existing installation is separate.

## Pull requests and main

`CI` runs on pull requests to `main`, pushes to `main`, and manual dispatch. Its required matrix covers the check harness, platform and Baskule server tests, hosted-web unit/browser checks, mobile unit/React tests, shared client packages, desktop checks, scoped typechecks and the hosted-web build. `CI required` succeeds only when every required matrix lane succeeds.

Mobile component tests use the existing mocked native test environment. They do not establish device acceptance. The manual `upstream` input also runs the upstream server/web unit suites. CI disables remote evidence lookup and recording; it never pushes evidence refs or reads deployment configuration.

```sh
gh workflow run ci.yml --repo baskule/baskule --ref main -f upstream=true
```

## Verify the complete factory

Run `Release factory` manually to build and check a candidate without publishing a GitHub release:

```sh
gh workflow run release.yml --repo baskule/baskule --ref main \
  -f verify_only=true -f include_native=true
```

The backend job builds the Worker, SpaceCell and four runtime images, then exercises the disposable fake-model release stack. Backend image IDs remain in that job; other jobs receive explicit artifacts. The Linux app job builds hosted web and a real AppImage and runs the packaged application under Xvfb. Cold OpenShell compilation can be lengthy; disk and build evidence are retained in the run.

The native workflow compiles Android arm64, an iOS simulator app, macOS arm64/x64 and Windows x64. Windows packaging executes the existing native-load and server-archive probes. iOS includes a simulator install/launch smoke. Android does not add an emulator lane. Optional upstream Windows package diagnostics remain manual.

Each artifact includes checksums and verification/signing status. Android's default release build uses a debug certificate; desktop output is unsigned by default; the iOS simulator ZIP is not an installable iPhone IPA. These outputs prove the named build and smoke checks, not store readiness or complete native product acceptance.

## Tags and releases

A `v*` tag starts the release factory with a version derived from the tag. The draft GitHub release waits for backend, Linux apps and native builds to succeed. This path does not deploy an installation or submit apps to stores. A manual verification run creates no release. Publishing a manual draft requires an explicit version and `verify_only=false`.

Versions and source revisions are recorded with the outputs. Use a versioned tag for an intended release. Local desktop builds default to development version `0.0.0`; `BASKULE_VERSION` overrides it.

## Production signing

Signing is a separate, explicit native-workflow dispatch from the default branch. Configure the `native-release` GitHub environment with required reviewers and deployment branch restrictions before adding owner credentials. The unsigned `native-ci` environment needs no credentials. Missing signing inputs fail a requested signed build.

Android needs an owner keystore and its passwords/alias. macOS needs Apple signing/notarization credentials, an owned team/profile and the relying-party domains required by the inherited signing contract. Windows uses the inherited Azure Trusted Signing provider. Enter credentials through the supported secret channel and GitHub environment secrets; never commit signing files or paste credentials into logs.

iOS device archives, provisioning, TestFlight and App Store submission require their own owner configuration. The current iOS lane verifies the simulator build only.

## Inspect evidence

Use a run's job logs and artifacts to inspect failures, checksums, package status and source provenance. Classify a failure before rerunning only the affected jobs. Keep package/browser/unit evidence distinct from physical-device acceptance. Verification artifacts are retained for one day; a verified GitHub release is the durable distribution record.
