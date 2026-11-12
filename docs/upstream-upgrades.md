# Upgrade the T3 Code base

Build each upgrade from the new upstream release. Reapply the Baskule behavior that
the product still needs, adapting it to upstream's current design. Remove custom code
when upstream supplies the behavior. This keeps the next upgrade from inheriting
every workaround from the previous one.

## Confirm the release and explain the decision

Read `README.md`, `AGENTS.md`, and `app/BASKULE.md` from the latest `origin/main`.
Fetch `main` before starting. Use its current commit as the Baskule source for this
upgrade, including changes made since the previous upstream integration.

Verify the target through GitHub's release API. Record the tag, resolved commit,
publication date, and release URL. Require `draft=false`, `prerelease=false`, and a
stable version tag. Ignore nightlies and changes made after that tag.

Read every stable release in the gap and paginate the complete commit comparison.
Use that research to write a short decision summary, normally under 400 words.
Start by confirming that a stable release exists and naming Baskule's current base.
Then group changes by product area in a compact table with these columns:

| Area | Upstream change and Baskule's current behavior | Adopt, adapt, disable, or remove | Reason |
| --- | --- | --- | --- |
| One user-facing capability per row | Explain the released difference | State the resulting product choice | Explain the benefit or maintenance cost |

Include the number of stable releases behind, a recommendation, and the main
adaptation risks. Link a few supporting sources where useful. Keep the commit
inventory in working evidence. Do not report individual PRs one by one or include
open PRs as part of the released gap. Release monitoring requests analysis only;
ask the owner before starting an integration unless it is already authorized.

## Prepare the new base and the Baskule changes

1. Create one integration branch from freshly fetched `origin/main`. Record that
   commit as the starting Baskule revision. Keep other worktrees unchanged.
2. Read the instructions and run `scripts/worktree setup`, then source
   `scripts/env.sh`. Use `scripts/check plan` to identify the affected checks.
3. In a separate upstream clone, resolve the old and new release tags. Compare the
   old upstream tree with `app/` at the starting Baskule revision. Include added
   files, deleted files, executable modes, and changes outside `app/` that depend
   on upstream contracts.
4. Group the Baskule differences by purpose. Decide which to retain, adapt, replace
   with upstream, or remove. Use the actual source diff as well as `app/BASKULE.md`;
   the documentation alone may omit recent fixes.
5. Materialize the complete target release as the application starting tree in
   disposable staging under `.run/`. Preserve upstream licenses and attribution.
   Reapply only the reviewed Baskule changes to that tree.

The starting Baskule revision supplies required product behavior. The new upstream
release supplies its implementation structure. For overlapping edits, compare the
old upstream code, the current Baskule code, and the new upstream code. Reimplement
the retained behavior in the new design. A three-way patch can help transfer an
unchanged customization, but every conflict needs review. Do not resolve a conflict
by restoring an old Baskule file wholesale.

Disable or remove unwanted features from the new base as explicit Baskule changes.
Do not prepare the base by reverting a list of upstream PRs. One PR can contain
fixes that useful and unwanted features share. Inspect newly added paths as well
as previously removed ones, and retain migrations and decoders required by the
supported compatibility window.

For each retained customization, keep its purpose and integration boundary clear
in `app/BASKULE.md`. Explain why upstream cannot supply it yet. Keep temporary
inventories, conflict records, and commands under `.run/evidence/`. Update the
maintained product description instead of appending a chronological patch history.

## Adapt the product at its existing boundaries

Check these areas against the released upstream source and the starting Baskule
revision:

- Preserve platform authentication, spaces, authorship, plugins, and per-space
  computers. Keep the shared SQL client, multiplexed alarm, and same-cell request
  described in the [embedded runtime guide](../platform/src/agent/README.md).
- Keep OpenCode 2 as the only executable agent driver. Compare the upstream SDK
  requirement with both Baskule's provider package and embedded runtime before
  changing versions. An older upstream pin is not a reason to downgrade Baskule.
  Validate a chosen runtime and SDK combination together.
- Reuse upstream voice controls and lifecycle behavior. Route transcription through
  Baskule's existing supported boundaries and remove the superseded local voice
  implementation. Check recording, cancellation, transcription errors, and text
  insertion on each affected client. Do not leave controls that call an unavailable
  hosted service.
- Hide tool calls by default through upstream's visibility preference. Preserve an
  explicit user choice. Verify both a fresh profile and saved settings from the
  previous Baskule version, including how a former default is decoded.
- Reuse translation infrastructure present in the released tag. Preserve Baskule's
  locales and translation CI where upstream does not replace them. Unreleased
  translation proposals are outside the upgrade. Check new and adapted UI strings
  through the existing extraction and validation commands.
- Review Labs settings, policy controls, telemetry, downloads, branding, native
  connections, and workerd trims. Match visible controls to actual RPC capability.
  Keep excluded providers, forge workflows, linked environments, and T3 commercial
  services outside Baskule's supported product scope.

Avoid new services or abstractions solely to make the import easier. Follow the
repository's architecture agreement process if an adaptation requires one.

## Preserve released data

Read the current migration boundary in `app/BASKULE.md` and the compatibility window
in `app/packages/contracts/release-compatibility.json`. Inspect every new upstream
migration and every change to migration registration or ordering.

Adapt migrations to the tables Baskule actually ships. Preserve identifiers already
recorded in released databases. Do not add empty migrations for retired layouts,
reuse an applied identifier for a different change, or reset a database to make
the new code start.

Use disposable fixtures representing supported released data. Prove that an old
database upgrades, retains its records and relationships, and reopens without
reapplying completed work. Check fresh databases too. Run the tests through both
the relevant Node migration path and the hosted SQL adapter when affected.

Schema and layout changes need forward migrations. If a change cannot migrate,
follow the maintainer approval and deployment documentation rules in `AGENTS.md`.
Testing against or changing a deployed installation still requires its operator's
authorization.

## Verify and prepare the pull request

Update the upstream tag and commit in `app/BASKULE.md` and `source-provenance.json`.
Keep tool pins aligned, regenerate lockfiles from reviewed manifests, and sync
third-party notices. Run frozen installs for both workspaces.

Use focused tests while adapting each area. For the completed integration, verify
the web and SpaceCell builds, affected typechecks and lint, `scripts/check space`,
and `scripts/check upstream`. Run a disposable fake-model journey through the
hosted app. Verify affected native clients separately. Follow the
[verification skill](../.agents/skills/verify-baskule/SKILL.md) and the
[native verification guide](mobile-verification.md). Keep evidence under `.run/`.
Real-model checks, performance samples, and translation generation with paid
providers need their existing explicit authorization.

Review the final difference from the target upstream tree. Every remaining Baskule
change needs a current product or compatibility reason. Check for duplicate
implementations, restored excluded features, stale imports, and bypassed checks.
An independent reviewer must inspect the integration and its verification evidence.

Fetch `origin/main` again before marking the PR ready. Incorporate any new Baskule
changes and rerun checks whose inputs changed. Include the verified base revision
in the working evidence.

Open one PR against `main` using the repository template. Start with the stable
release that prompted the upgrade and the resulting user benefits. Summarize
retained adaptations by area, document migrations, and report verification limits.
Keep the PR description readable at a glance. Follow the
[review loop](review-loop.md) until required checks and material findings are resolved.

Bundle-time substitutions do not appear in a comparison with upstream source. Review the target
and anchor inventory in [app/BASKULE.md](../app/BASKULE.md#v019-bundle-time-customizations), including the
Effect HTTP builder in installed dependencies. Keep each strict file-match and source-body guard,
run the rewrite bundle fixtures, and verify the minified hosted artifact after updating them.
