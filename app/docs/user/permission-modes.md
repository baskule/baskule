# Permission modes

Permission modes control when an agent must ask for your approval before running commands or editing files. Set the mode per thread from the composer (`mod+shift+a` or the model picker's **Permissions** menu).

Configure the default for new threads in **Settings → Threads → New threads → Permissions** (default: **Full access**; projects can override). Administrators can cap available modes with a [managed policy](./managed-policy.md#permission-modes).

| Mode                  | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                          |
| **Auto-accept edits** | Approves file edits automatically; commands and other actions may still ask.              |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about risky ones. |
| **Full access**       | Runs commands and edits without approval prompts.                                         |

Permission modes never stop an agent from asking clarifying questions. Subagent approval requests appear in the parent conversation with the subagent's name so you can approve without switching threads.

## Git push hooks below Full access

## OpenCode permissions

OpenCode enforces the selected mode. Some read-only actions can proceed in **Supervised**. **Auto** uses the same rules as **Supervised**, because OpenCode has no automatic approval reviewer.

See [OpenCode setup](./providers-opencode.md) for its configuration and approval details.
