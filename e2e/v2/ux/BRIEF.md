# UX review loop: brief for the reviewer sub-agent

You review the usability of Baskule 0.2 (a multi-user, ChatGPT-like assistant with an agent computer per space)
as a careful product designer would, on the **real stack**. You do not fix code: you produce findings.

## Inputs

- `e2e/v2/ux/journeys.mjs`: scripted journeys that drive system Chrome against the stack and save, per step, a
  screenshot (`.png`), the visible text and an accessibility snapshot (`.txt`) into `e2e/v2/artifacts/ux/<journey>/`.
  Run it with `e2e/v2/ux/run.sh` (it takes the stack lock and points the cells at the fake LLM; it prints the
  artifacts directory). Journeys:
  1. `admin-onboarding` — admin first sign-in, admin panel (people, spaces, health), add a person with a temporary
     password, invite a person, create a team space, add members;
  2. `member-first-chat` — the invited person accepts, lands on the home page, asks a first question, opens the
     space picker, the user menu, the apps page;
  3. `team-collaboration` — two members in a team space: one runs a long answer, the other watches, sends a message
     during the run (queue), names on messages;
  4. `file-round-trip` — attach a file, the agent writes an output file, the files panel, preview, download;
  5. `schedule-setup` — the scheduled-tasks page, create a schedule;
  6. `phone-layout` — the same key screens at 390×844.
- Product scope: `README.md` (current product scope), `docs/development-workflow.md` (verification).
- Users are non-technical knowledge workers. The product must not leak developer concepts (git, worktree, branch,
  ref, thread, provider, OpenCode, T3 Code, environment, checkout) except the "Based on T3 Code (MIT)" credit.

## What to look at

For each step, open the screenshot (Read tool) and the text snapshot. Judge:
- **Comprehension:** is it clear where I am, what this space is, who wrote what, what is running, what happened?
- **Leaks and noise:** developer vocabulary, internal ids, spurious warnings or toasts, debug text, raw markers.
- **Feedback:** loading/empty/error states, progress of a run, the computer starting, failures explained.
- **Flow:** number of steps, dead ends, missing confirmations, irreversible actions without a warning.
- **Layout:** overflow, truncation that hides meaning, overlapping elements, tap targets on the phone, alignment.
- **Consistency:** the same thing named the same way everywhere (chat vs thread, space vs project).

Messages in the journeys contain fake-model markers such as `[[fake:text …]]`: those are test scaffolding, not
findings.

## Output

Write `e2e/v2/ux-findings.md` (overwrite the round's section, keep earlier rounds), one table row per finding:

| # | Severity | Journey / step (screenshot) | Finding | Suggested fix | Where (best guess) |

Severity:
- **high**: blocks or misleads a normal user, or leaks something confusing on a main path;
- **medium**: noticeable friction, wrong or developer wording on a secondary path, missing feedback;
- **low**: polish.

Be concrete (quote the text you saw, name the screenshot). No more than ~25 findings; merge duplicates. End with a
3-line summary. Return the path of the findings file and the counts per severity.
