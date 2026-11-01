# Baskule

Baskule is built from the T3 Code v0.1.5 fork in this directory. Web, desktop, and mobile clients connect to a shared server.

Baskule runs exactly one agent provider: **OpenCode 2**. The SpaceCell deployment embeds OpenCode 2.1.3. Models from OpenAI, Anthropic, or other vendors run through OpenCode. There are no separate vendor harnesses or OpenCode 1.x runtime paths.

The provider adapter, driver registry, and multi-instance settings remain extensible. You can configure multiple OpenCode instances with separate endpoints, credentials, and models.

Start with the [project README](../README.md), [BASKULE.md](./BASKULE.md), and [agent instructions](./AGENTS.md). For local OpenCode setup, see [the provider guide](./docs/user/providers-opencode.md).

This fork retains the upstream T3 Code MIT [license](./LICENSE).
