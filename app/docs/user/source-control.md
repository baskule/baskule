# Local Git

Baskule retains generic Git operations for the desktop/server payload: clone a Git URL or local path,
commit, push, pull, branches, worktrees, and local diff review. Git uses the credentials configured
on the machine running the server. These inherited controls are outside the hosted chat UI.

Forge account integrations, repository publishing, pull request APIs, checkout, review guides and
review screens are removed. Ordinary repository and commit URLs follow the browser link settings.
Existing chats retain their saved PR context and searchable metadata.

A turn's changed files and diff show the turn's own work. Files brought in by a pull, merge or
rebase are excluded unless the turn edited, committed or resolved a conflict in them. The branch
comparison includes all changes against its base. Restore still restores the complete saved workspace.

The local Diff pane's **Commits** source lists the newest 100 commits in the branch comparison.
A merge commit shows its changes against its first parent.
