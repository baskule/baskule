# Visual replies and MCP apps

Agents can render self-contained HTML visuals (charts, diagrams, tables, image collages, mockups) and interactive MCP Apps inline in a thread on web, desktop, and mobile.

## Visual replies (HTML renders)

Ask an agent for a visual (e.g. "show this as a chart" or "make a collage of these screenshots"). The rendered page appears above the agent's reply, adapts to your light/dark theme, and runs sandboxed away from your T3 Code session.

- **Local images**: Embedded when published so they stay intact even if the original files move or are deleted.
- **Preview browser**: Before publishing, agents verify their visual with T3 Code's bundled headless Chromium (~120 MB one-time download, shared with [remote browser tabs](./remote-access.md#browser-host-setup)).
- **Network restrictions**: Previews can load public CDN assets but block private/local-network IPs. If Clash/Mihomo fake-IP DNS causes CDN loads to fail, inline the resource, add the host to `fake-ip-filter`, or switch proxy DNS to `redir-host`.

## MCP apps

Some MCP servers return an interactive app with their tool results, following the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of those tools, the app appears in the thread below the tool call, on web, desktop, and mobile. The tool call keeps its input and result. Rendering depends on the tool-result metadata exposed by OpenCode.

Apps follow your theme. An app can call tools on its own server and post a message to the thread; T3 Code asks first unless the server marks the tool as read-only, and it asks before every message. On mobile, an app also asks before opening a link, and T3 Code asks before saving a file an app offers. An app stays viewable after its agent stops, but using it needs the agent of the thread that created it running, so send a message in that thread first if the app says it is unavailable. An app that navigates away from its own page is stopped. Apps run only on an environment whose T3 Code server is current: on an older server, the thread shows a line asking you to update it in place of the app.

- **Safety**: T3 Code asks before an MCP app runs non-read-only server tools, posts messages to the thread, opens links (mobile), or saves files. Navigating away from its own page stops the app.
- **Session requirement**: Apps remain viewable after a turn ends, but interacting with them requires the thread's agent session to be running.
- **Full screen**: Expand an app full screen and press `Esc` (or the corner button) to return to the thread.
