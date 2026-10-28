# Baskule instructions for agents

Read [CONTRIBUTING.md](CONTRIBUTING.md), [build instructions](docs/building.md), and the [development workflow](docs/development-workflow.md). `app/` and `vendor/openshell/` have additional `AGENTS.md` instructions for their source.

## One repository

`github.com/baskule/baskule` (`origin`) is the only source of truth. Base every branch on `origin/main`, push only to `origin`, and open pull requests only there. Its history begins at the 2026-10-27 public initial commit. The earlier private OpenSoft repository is archived and must not be fetched, compared against, ported from, or pushed to. If a change you were told exists is missing from `origin/main`, stop and ask the owner instead of looking for it elsewhere.

## Alpha constraints

- No backward compatibility. When a design or data layout changes, remove the retired code and data layout. Do not add migrations, compatibility shims, dead flags, or test substitutes for retired layouts.
- Alpha data may be wiped. A change that requires a wipe must document the deployment steps and the data removed. Operating an existing installation still requires its owner's authorization.
- Keep the fewest moving parts. Propose new cells, Durable Object classes, bindings, services, processes, or abstractions before implementing them. Architecture changes need the owner's agreement.
- Keep one shared SQL client per SpaceCell, the multiplexed alarm, and the same-cell self-request required by celld issue #258. See [the embedded runtime README](platform/src/agent/README.md).
- Put experiments and reproduction notes in `docs/`; keep temporary files under ignored `.run/`. Do not add probe routes or flags to runtime code.
- Current READMEs describe the current design. Keep private host details, credentials, logs, and user data outside tracked documentation.

## Focus verification on the change

Run `scripts/worktree setup`, then `source scripts/env.sh`. Build SpaceCell with `scripts/worktree runtime` only when the local app or a check imports the runtime. Rerun it after changing `app/`.

Use `scripts/check plan` to select the smallest check that proves the change. During iteration, use focused unit checks and the affected component or feature journey. Run wider verification only when the change or an unresolved risk justifies it. Reuse passing evidence while its inputs remain unchanged.

Use the fake LLM. Real-model checks and performance samples require an explicit request. Deployed-stack checks, deployments, restarts, and data wipes require the installation owner's authorization. Live checks exercise the deployed build and can change its provider routing.

Classify a failed check as a product, harness, or environment failure before rerunning it. Rerun only the failing selection. Wait on observable conditions with a timeout, never fixed sleeps. If ports are busy, identify their owner instead of killing processes blindly. Stop stacks you started and preserve evidence under `.run/evidence/`.

Start long commands once and wait for their completion notification. For GitHub runs, use `gh run watch <run-id> --exit-status`. Use available thread or pull-request wait tools instead of repeated status reads.

## Changes and review

Use one branch per change and open pull requests against `main`. Explain the problem, what was removed, what was kept and why, and any required data wipe. Follow the [review loop](docs/review-loop.md). Reviewer suggestions do not expand the task's scope.

Preserve upstream licences, attribution, and third-party notices. Do not publish credentials, signing material, private environment files, raw session payloads, or assistant state.
