# Review a contribution

Keep review focused on the pull request's intended behavior, compatibility requirements, and verification evidence.

## Prepare for review

Describe the problem, the resulting behavior, and the limits of the change. Explain significant removals and retained compatibility code. Include the checks you ran, their results, and any gaps in coverage. Document migrations and deployment steps when existing installations are affected.

## Review the change

- Read the surrounding code and applicable repository instructions.
- Check for incorrect behavior, broken callers, security issues, and compatibility or migration gaps.
- Verify that the evidence covers the intended behavior. Name any missing check and what it would prove.
- Explain each finding with a file location, the triggering condition, and its impact. Suggest the smallest correction that resolves the problem.
- Distinguish required fixes from optional improvements. Keep unrelated suggestions as follow-up work.

## Resolve findings

Reproduce or otherwise verify each reported issue. Fix confirmed issues within scope and rerun the affected checks. If you disagree, explain why with code references or verification evidence.

Ask maintainers to resolve disagreements that affect correctness, compatibility, architecture, or the scope of the contribution. An unresolved material issue needs a decision before merge. After a fix, review the changed code and any remaining findings without reopening resolved discussions unless new evidence changes the conclusion.
