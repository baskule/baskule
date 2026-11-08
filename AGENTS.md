# Working in the Baskule repository

These guidelines apply to contributors and coding assistants. Read [CONTRIBUTING.md](CONTRIBUTING.md), [build instructions](docs/building.md), and the [development workflow](docs/development-workflow.md). Follow additional instructions in the source directory you change, including `app/AGENTS.md`.

`app/AGENTS.md` keeps upstream T3 Code guidance; where it conflicts with this file, this file wins, and 'maintainers' means Baskule maintainers. Use `app/AGENTS.md` for code style, testing, and Effect conventions inside `app/`. Its **Dev servers**, **Test data**, and **Pull requests** sections describe upstream T3 Code workflows and do not apply.

## Compatibility and architecture

- Client/server compatibility follows `app/packages/contracts/release-compatibility.json`. Keep code needed within that window and remove it when support ends. Do not add dead flags or test substitutes for retired layouts.
- Released installations hold real user data. Schema and data-layout changes need forward migrations. Changes without a migration require maintainer approval and documented deployment steps, including affected data. Installation operators must authorize changes to their installations.
- Keep the fewest moving parts. Propose new cells, Durable Object classes, bindings, services, processes, or abstractions in an issue before implementing them; architecture changes need maintainer agreement.
- Keep one shared SQL client per SpaceCell, the multiplexed alarm, and the same-cell self-request required by [celld issue #258](https://github.com/denoland/celld/issues/258). See [the embedded runtime README](platform/src/agent/README.md).
- Keep maintained explanations and reproducible contributor guidance in `docs/`. Put temporary experiments, logs, and verification evidence under ignored `.run/`. Do not add probe routes or flags to runtime code.
- READMEs describe the current design. Keep private host details, credentials, logs, and user data outside tracked documentation.

## Focus verification on the change

Run `scripts/worktree setup`, then `source scripts/env.sh`. Build SpaceCell with `scripts/worktree runtime` only when the local app or a check imports the runtime. Rerun it after changing `app/`.

Use `scripts/check plan` to select the smallest check that proves the change. During iteration, use focused unit checks and the affected component or feature journey. Run wider verification only when the change or an unresolved risk justifies it. Reuse passing evidence while its inputs remain unchanged.

Use the fake LLM by default. Real-model checks (`@real`) can call paid providers. Run real-model checks and performance samples (`@perf`) only when explicitly requested. Deployed-stack checks, deployments, restarts, and data wipes require authorization from the installation's operator. Live checks exercise the deployed build and can change its provider routing.

Classify a failed check as a product, harness, or environment failure before rerunning it. Rerun only the failing selection. Wait on observable conditions with a timeout, never fixed sleeps. If a port is busy, identify the process using it; never stop another run or worktree to free it. Stop stacks you started and preserve evidence under `.run/evidence/`.

Start long commands once and wait for completion. For GitHub runs, use `gh run watch <run-id> --exit-status`. Inspect CI logs and results before retrying a failed job.

To drive the app and record evidence, follow [the verification skill](.agents/skills/verify-baskule/SKILL.md).

## Changes and review

Work on one branch per change from `main` of `baskule/baskule`, in a fork or, with write access, in the repository. Open the pull request against `main`. Fill in the [pull request template](.github/pull_request_template.md). Follow the [review guidance](docs/review-loop.md) and keep follow-up suggestions separate from the change's scope.

Preserve upstream licenses, attribution, and third-party notices. Do not publish credentials, signing material, private environment files, raw session payloads, or assistant state.
