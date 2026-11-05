# Contribute to Baskule

Baskule is beta software. Released data needs forward migrations; client/server compatibility follows `app/packages/contracts/release-compatibility.json`. Discuss architecture changes before adding services, processes, cells, or bindings.

## Prepare a change

1. Read [AGENTS.md](AGENTS.md) and the instructions in the source directory you will change.
2. Follow [Build Baskule](docs/building.md) to install the pinned tools and dependencies.
3. Create a branch from `main` for one change.
4. Use the [development workflow](docs/development-workflow.md) to select focused verification.

Keep changes scoped to the problem. Keep compatibility code within the declared window and remove it when support ends. Keep private configuration and generated output outside Git.

## Open a pull request

Describe the observable behavior before and after the change. Explain what was removed, what was kept and why, and which checks prove the result. State any limitations in that evidence.

A change that cannot migrate existing data needs the owner's explicit approval, with affected data and deployment steps documented. Do not deploy, restart, or wipe another person's installation without authorization.

Follow the [review loop](docs/review-loop.md). Address findings within the change's scope and record other suggestions as follow-up work.

Preserve the licences and notices in `app/` and its nested dependencies.
