# Messages and context

Use the composer to send prompts, attach files, reference threads or pull requests, invoke skills, and steer or queue follow-ups.

## Limits and large pastes

- **Message length**: Up to 120,000 characters.
- **Large pastes**: Pasting 32 KiB+ of text (or any paste that would exceed the message limit) turns it into a text-file attachment so it doesn't bloat the prompt. Use `Cmd+Shift+V` (Apple) or `Ctrl+Shift+V` (Windows/Linux) to paste inline instead.

## Formatting

The composer writes Markdown and shows it styled as you type. When your cursor
is on styled text, its Markdown shows instead, such as `**bold**`, and the
markers edit like any other text: delete them to remove the style, or change
`**` to `*` for italic. The style updates when your cursor leaves. To write
plain Markdown with no styling, turn off **Settings → Chat → Rich text
composer**. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---`
become lists, task lists, quotes, headings and rules; ` ``` ` followed by Enter
opens a code block. What you typed is what the agent receives, markers and
numbering included.

Some styled text containing or touching literal Markdown characters, such as a
bold `path\` or `2*3`, keeps its styling without showing markers. Use formatting
shortcuts or turn off rich text to edit the formatting of those ranges.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line moves out one level, then leaves it; **Tab** nests a list item
under the one above and **Shift+Tab** moves it back out. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Attach files

Attach up to **100 files** per message:

- **Images**: Up to 10 MiB each, 80 MiB total per message. HEIC/HEIF photos are converted to JPEG, and oversized photos are resized automatically.
- **Other files (including videos)**: Up to 50 MiB each (subject to environment limits). Video attachments pass a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments) sends supported videos natively to Gemini models.

Files upload to the environment's machine as soon as you attach them, and all uploads must finish before sending. Provider and model limits still apply.

- **Web and desktop**: Drag, paste, or pick files. Reloading before an upload finishes requires re-attaching.
- **Mobile**: Pick files, share into T3 Code via the system share sheet, or drag images in Android split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose your default follow-up behavior in **Settings → Chat → Follow-up behavior** (per client):

- **Queue**: Holds the message on the server for the next turn.
- **Steer**: Injects the message into the running turn (when supported by the agent).

Shortcuts while a turn is running:

- **Opposite action**: `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) uses the non-default action. If your send shortcut already requires `Cmd/Ctrl+Enter`, add `Shift`. On mobile, long-press the send button or use `Cmd/Ctrl+Return` on a hardware keyboard.
- **Steer oldest queued message**: `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux) sends the first queued message as a steer without touching your current draft. Remap `thread.steerQueuedMessage` in **Settings → Keybindings**, or add a rule in your [keybindings file](./keybindings.md#edit-the-configuration-file) to trigger it on `mod+enter` when the composer is empty:

```json
{
  "key": "mod+enter",
  "command": "thread.steerQueuedMessage",
  "when": "composerFocus && turnRunning && composerEmpty"
}
```

- **Edit most recently queued message**: `Option+Up` (macOS) or `Alt+Up` (Windows/Linux) at the start of the composer (`thread.editQueuedMessage`).

Slash commands (such as `/compact` or `/context`) wait for the current turn to finish rather than steering into it. [Goal](#goals) commands are the exception.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments so you can preview them and queue messages offline. Uploads resume on reconnect, and drafts/queued messages survive app restarts and T3 Connect sign-out (restored when signing back into the same account).

## Custom models and defaults

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by OpenCode affect turns.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that provider
instance:

```json
{
  "providerInstances": {
    "opencode": {
      "driver": "opencode",
      "config": { "customModels": [{ "slug": "openai/gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Quote an assistant response

- **Web and desktop**: Select text in an assistant message and click **Cite in composer**. Click the pencil on the chip to add or edit a comment; click the chip to jump back to the source.
- **Mobile**: Long-press an assistant response, select text, and tap **Cite**. Tap a quote chip to edit its comment, remove it, or jump to the source message.

Quoted text and comments count toward the message length limit and are preserved across copy/paste and [stashed prompts](#prompt-stash).

## Recall a sent prompt

Press `ArrowUp` in an empty composer to cycle backward through earlier prompts in the thread, and `ArrowDown` to move forward. Only prompt text is restored (not attachments or context chips). Editing a recalled prompt turns it into a normal draft.

## Suggested next prompt

Enable **Settings → Labs → Suggest next prompt** (web and desktop) to show a predicted next message in the empty composer after a Claude or Codex turn completes.

- Press `Tab` to accept or `Escape` to dismiss.
- Each suggestion uses one cached request against your plan's usage. Claude skips suggestions on the first turn and near usage limits.
- Codex requires CLI version 0.165+ (update in **Settings → Providers**). Open Claude threads pick up the setting after restarting.

## Edit an earlier prompt

On web and desktop, select **Edit from here** under a sent message to rewind the conversation to before that message and return it to the composer:

- **Revert and keep changes**: Rewinds the conversation only.
- **Revert files too**: Restores workspace files to the checkpoint before that message (including your own edits). Only available for worktree threads when no other thread or active session shares that directory.

Rewinding removes later messages from the active thread and provider history (requires provider rewind support), but cannot undo external actions or separate provider memory.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to stash the current draft and its attachments (wait for uploads to finish first). Press the same shortcut in an empty composer to restore the stash (or open the stash menu if you have multiple).

- Holds up to 100 prompts in browser storage; stashes are never auto-deleted.
- Stashes with uploaded files must be restored in their original environment. Uploads expire after 24 hours; use **Attach again** or remove expired files before sending.

## Voice input

Dictate into the composer with the microphone button or `mod+shift+d` (web and desktop). Audio stays on-device or goes only to an environment/provider you explicitly choose in **Settings → Voice**. See [Voice input](./voice-input.md) for setup, mobile dictation, and microphone priority.

## Queued messages

Queued messages appear at the end of the thread (web/desktop) or above the composer (mobile). From a queued message you can:

Context compaction is automatic. When a conversation nears the model's context
window, the agent summarizes it on its own and continues the turn. The thread
shows a **Context compacted** divider at that point; there is nothing to send or
confirm.

## Goals

When the selected model supports goals, send `/goal` followed by what "done" means, for example `/goal all tests in packages/api pass`. The agent keeps working across turns until it judges the goal met. The thread shows **Goal** while it works.

`/goal` alone shows the current goal. `/goal clear` removes it.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

Saved pull request context keeps its captured title, branches and URL. Its link opens as an
ordinary web link. New pull request lookup and insertion are unavailable.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or onweb and desktop drag a thread out of the sidebar and
drop it on the composer; a multi-selection drops together. The chip shows the thread's
current title and opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

Dropping a thread from another environment attaches a saved transcript file. The source
environment must be connected and up to date. The transcript includes the visible history and
saved text context at the time of the drop; later messages and the contents of attached files
are not copied. The agent can read the saved transcript after the source disconnects. Normal
file attachment limits apply.

Type `@` and part of a model or provider name, such as `@opus`, to name that model for the
agent, for example when delegating. It does not change the thread's model. Join words with
`:`, `/` or `-`, as in `@opus:opencode`.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete T3 Code tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

- **Pull requests (`#`)**: On web and desktop, type `#` to browse recent PRs in the current repository (linked PRs appear first), type digits to match by number, or type a word to search by text.
- **Threads (`@`)**: Type `@` and part of a thread title to reference a thread on the same server (or on a linked machine when Linked environments is enabled). You can also drag threads from the sidebar onto the composer, or paste a copied thread link. The prompt carries only a reference—the agent reads the thread on demand. Dropping a thread from an unlinked environment attaches a snapshot transcript file instead.
- **Models (`@`)**: Type `@` and part of a model or provider name (e.g. `@opus` or `@opus:opencode`) to reference a model in your prompt (such as for delegation) without changing the thread's model.
- **Images vs. files**: Images keep a thumbnail shelf above the composer plus optional inline chips; files live only as inline chips (deleting the last chip removes the file).

## Attached files

Select any file chip in a draft or sent message to preview it (syntax-highlighted code/JSON, rendered/raw Markdown/HTML/CSV/TSV, audio playback, and ZIP folder browsing up to 50 MB). Large text files show a truncated preview—save the file to read it in full.

## Images and videos in messages

Select an image or video attachment or link to preview it.

- **Web and desktop**: Right-click media to save it or copy its path/URL.
- **Mobile**: Long-press a thumbnail and choose **Save or share**.

File links point to the file on the environment's machine, so moving or deleting the original breaks the preview—save a copy if you need to keep it.

## Files outside the workspace

Following an agent's file link to a file outside the workspace opens it read-only. External HTML files cannot load neighboring scripts, styles, or images.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open rendered (HTML previews are sandboxed from your T3 Code session; line-specific HTML links open source view). On mobile, PDFs open in the native iOS viewer or an installed Android viewer.
