# Embedded OpenCode tools

Baskule runs OpenCode inside each space's SpaceCell. The runtime enables `webfetch`, `websearch`, and Code Mode `execute`. MCP servers use `codemode: false` so their tools appear directly in the conversation.

## Search selection

The embedded configuration selects a random registered search provider. OpenCode can choose a provider without showing its first-use selection form. Provider availability, credentials, and quotas still depend on the selected external service.

## Code Mode and browser tools

Code Mode exposes registered Code Mode tools through `execute`. OpenCode's built-in browser plugin requires its desktop attachment. Those tools cannot drive Baskule's shared preview browser on a headless server.

The embedded workerd profile uses an empty config-plugin source. Removing the built-in browser with an ordinary config-plugin removal is therefore ineffective. Tool permission policies govern execution; they do not remove entries from the offered catalog.

Baskule keeps MCP tools direct because the client projects their individual names into browser actions, HTML render cards, and MCP app cards. Wrapping those calls in one `execute` item loses the tool-specific projection. Changing this requires the adapter to expose nested calls as individual tool items.

## Large tool results

The shared truncator keeps OpenCode's stock limits of 2,000 lines and 50 KiB. Results beyond those limits are written to the space's computer under `/sandbox/space/tool-output`. Published output paths point at that computer, where read and shell tools can reach them.

Shell results pass through a separate capture before shared truncation. The runtime copies the full capture to the computer and keeps its runtime capture for `shell_output`. A failed copy fails the tool instead of publishing an unreadable path.

Each spill write also prunes `tool_*` and `sh_*` files older than OpenCode's seven-day retention. Pruning is best effort. Tool-output files otherwise live with the computer volume. For a single line beyond the byte limit, use shell byte ranges to read the full content.

## Execute failures

A Code Mode program can complete its invocation with `metadata.error: true` when the program throws. T3's OpenCode adapter maps that flag to a failed tool item for both live events and reconstructed history. The exception text remains the output. The enclosing model turn can still succeed if it handles the failure.

## Focused checks

Prepare the runtime as described in [the development workflow](development-workflow.md). The following fake-model checks exercise tool discovery, direct MCP calls, readable spill files, and tool availability after restart:

```sh
scripts/check agent:plain-chat-no-computer,runtime-mcp-at-first-step
scripts/check agent:large-tool-output-readable-on-computer,restart-mid-chat-keeps-toolset
```

The discovery checks inspect the model prompt and call a fake MCP tool. They do not establish external search availability. Computer-backed checks require the matching local computer and OpenShell images.
