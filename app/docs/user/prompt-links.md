# Prompt links

A prompt link opens T3 Code with a prefilled draft—useful for sharing prompts or adding one-click fixes in pull request comments.

Links **never** auto-send or change your permission mode, branch, or worktree. They only open a draft for you to review and send.

## Create a link

- **From the composer**: Open the command palette and choose **Copy prompt link** (or **Copy prompt link with repo and model** on GitHub projects).
- **From a sent message**: Click **Copy prompt link**.
- **By hand** (URL-encode the prompt, e.g. with `encodeURIComponent`):

```text
https://app.t3.codes/new?prompt=Rate%20my%20swearing
https://app.t3.codes/new?prompt=Fix%20the%20build&repo=owner/name&provider=opencode&model=openai/gpt-5.5
```

| Parameter  | Meaning                                          |
| ---------- | ------------------------------------------------ |
| `prompt`   | The prompt. Required. At most 8,000 characters.  |
| `repo`     | A GitHub repository, as `owner/name` or its URL. |
| `provider` | The `opencode` provider.                         |
| `model`    | A model of that provider, by its id or name.     |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

## How links open

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and T3 Code tells you.

- **No `repo`**: Opens a no-project draft on your last-used machine.
- **`repo`**: Opens in your most recent project for that repo (or offers **Clone** / **Use without project**).
- **`provider` / `model`**: Applied if configured; otherwise falls back to your default with a notice.
- **`pr`**: Opens the thread linked to that PR, or prepares a new worktree draft on the PR branch after you confirm checkout.
- **Thread prompt link** (`https://app.t3.codes/<environment>/<thread>?prompt=…`): Prefills that thread's composer (asks before overwriting an existing draft).

T3 Code strips invisible characters (such as zero-width and hidden tag characters) and warns you if a prompt contained them.

## Share a thread

**Copy thread** copies a link (`https://app.t3.codes/threads/<environment>/<thread>`) that opens in T3 Code on desktop, web, or mobile and pastes into any composer as a thread chip. Only someone connected to the machine running that thread can view it.
