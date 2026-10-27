# Provider constraints

Baskule registers only the `opencode` driver, pinned to OpenCode 2. Provider protocols,
permissions and capabilities belong at the adapter boundary. The ProviderAdapter interface,
driver registry, provider instances and multi-instance settings remain extension points.

## Instance isolation

Each OpenCode instance owns its server, configuration and credentials. OpenCode 2 serves every
directory from one server per instance. Each thread registers its own `t3-code-<thread>` MCP
entry; session permission rules deny other threads' entries. External servers remain externally
owned and may need an external restart after configuration changes.

OpenCode stores permanent approval grants for the project. Automatic full-access replies use
`once`. Session-wide approval becomes Baskule's rule on that session without widening other
threads' permissions.

## Capabilities and lifecycle

Orchestration and clients consume capabilities rather than assuming support from a driver name.
Status refresh must not start agent work or trigger authentication. Native sessions and turn
state belong to the adapter; portable context handoff remains the generic boundary between
instances. OpenCode 2 owns automatic context compaction. There is no manual compact command.

Updates run only through an installer that owns the executable. Otherwise the update remains
manual. Replay fixtures exercise the real adapter and orchestration projections, including
`opencode2_compaction`. See [adding a provider](./adding-a-provider.md) for the preserved seams.
