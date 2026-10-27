# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines OpenCode 2 history from your connected environments. It shows token use,
cache savings, model breakdowns, and estimated API-equivalent cost. These estimates are not
your subscription bill. Select a model under **Breakdown** to inspect its trend and pricing.

OpenCode reads its SQLite session-message database. Set `OPENCODE_DATA_DIR` on the server to
read another data directory; comma-separated paths read multiple directories. Configured
instances sharing a history directory count once, including disabled instances.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. Refresh to rescan history and update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** shows the allowance reported by OpenCode Go. It requires OpenCode running
locally with a Go API key or an OpenCode Console API-key connection. External OpenCode servers
and Console browser sign-in alone do not expose these limits. You can configure
`OPENCODE_API_KEY` in the instance's **Environment variables**, then refresh provider status.

Opening Limits checks connected environments automatically. Refresh for a new reading. The
`/usage-limits` composer command opens the same saved snapshot without running the agent.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
