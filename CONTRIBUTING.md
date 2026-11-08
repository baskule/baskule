# Contribute to Baskule

Baskule is beta software. Released data needs forward migrations; client/server compatibility follows `app/packages/contracts/release-compatibility.json`. Open an issue to agree on architecture changes before adding services, processes, cells, or bindings.

## Prepare a change

1. Read [AGENTS.md](AGENTS.md) and the instructions in the source directory you will change.
2. Follow [Build Baskule](docs/building.md) to install the pinned tools and dependencies.
3. Work on one branch per change from `main` of `baskule/baskule`, in a fork or, with write access, in the repository.
4. Use the [development workflow](docs/development-workflow.md) to select focused verification.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Ask questions in [GitHub Issues](https://github.com/baskule/baskule/issues).

Keep changes scoped to the problem. Keep compatibility code within the declared window and remove it when support ends. Keep private configuration and generated output outside Git.

## Open a pull request

Open the pull request against `main`. Use the title format `type(scope): subject`, with a required scope. Fill in the [pull request template](.github/pull_request_template.md).

A change that cannot migrate existing data needs maintainer approval, with affected data and deployment steps documented. Deployments, restarts, live checks, and data wipes require authorization from the installation's operator.

Follow the [review guidance](docs/review-loop.md). Address findings within the change's scope and record other suggestions as follow-up work.

Preserve the licenses and notices in `app/` and its nested dependencies.

## Licensing

Contributions are licensed under the repository's [MIT license](LICENSE), on the same terms as the project (inbound = outbound).
