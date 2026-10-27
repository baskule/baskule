# Contribute to Baskule

Baskule is alpha software. Changes can replace APIs and data layouts without migrations. Discuss architecture changes before adding services, processes, cells, or bindings.

## Prepare a change

1. Read [AGENTS.md](AGENTS.md) and the instructions in the source directory you will change.
2. Follow [Build Baskule](docs/building.md) to install the pinned tools and dependencies.
3. Create a branch from `main` for one change.
4. Use the [development workflow](docs/development-workflow.md) to select focused verification.

Keep changes scoped to the problem. Remove retired paths instead of preserving compatibility code. Keep private configuration and generated output outside Git.

## Open a pull request

Describe the observable behavior before and after the change. Explain what was removed, what was kept and why, and which checks prove the result. State any limitations in that evidence.

If deployment requires an alpha data wipe, list the affected data and deployment steps. Do not deploy, restart, or wipe another person's installation without authorization.

Follow the [review loop](docs/review-loop.md). Address findings within the change's scope and record other suggestions as follow-up work.

Preserve the licences and notices in `app/`, `vendor/openshell/`, and their nested dependencies.
