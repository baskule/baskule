# Review loop

## Author's rule

- Give the reviewer the brief's intent, explicit out-of-scope work, diff and verification evidence.
- Verify each finding and grade it yourself against the intent: blocking = intended case is wrong;
  should-fix = a real bug callers will hit within that intent; nit = everything else, including unrelated paths,
  rare cases, small performance costs and extra compatibility. The reviewer's label is advisory.
- Fix confirmed blockers and in-scope should-fixes with the smallest change. Prefer deleting or narrowing code.
  Disagree with evidence. Decline nits and out-of-scope suggestions in one line and list them as follow-ups.
- Use at most three rounds. Later rounds check only changed code and open findings. Stop early when only nits
  remain; declined nits and documentation or formatting fixes need no new round.
- An unresolved blocker or should-fix at the limit, or a dispute after two replies, goes to the coordinator with
  both positions and their evidence. Reaching the limit is not approval. Do not agree just to end the loop.
- Report rounds, a findings ledger (ID, author-assessed severity, outcome and reason), and diff size before and
  after review (`git diff --shortstat <base>`). If review grew the diff, cut additions the intent does not need.

## Reviewer brief

```text
Read-only second opinion for PR #<PR>, unit <UNIT>, round <N>.
Intent: <intended behaviour from the unit brief>
Out of scope: <explicit exclusions>
Base: <SHA>  Diff: <command and paths>  Checks: <commands, results and evidence>
Unit brief: <paste>  Prior findings and author responses: <paste, if any>

Read the PR, surrounding code, AGENTS.md and the approved design.
Do not edit, run tests, builds or services, change state, or start subagents.
Find bugs, broken callers, unapproved architecture and mismatches with the intent.
Hold to the smallest change. Flag code, tests or guards the intent does not need.
Suggest an alternative only when it resolves a concrete in-scope defect or removes unnecessary code.
Check whether the evidence proves the acceptance criteria. Name any missing check and what it would prove;
the author decides which checks to run. Later rounds cover only changed code and open findings.

Severity: blocking = intended case wrong; should-fix = real bug callers will hit, within intent;
nit = everything else (unrelated paths, rare cases, small performance costs, extra compatibility).
Reply briefly: PASS, PASS+NOTES (only nits), or FAIL (open blocker or should-fix).
Give stable finding IDs, severity, file:line, evidence, impact on intent, and the smallest fix when needed.
Mark prior findings resolved or still open with a reason. Do not repeat declined nits as merge blockers.
```
