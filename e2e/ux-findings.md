# Baskule usability reviews

## Round 1 — independent parent review, 2026-10-23

Reviewed full-resolution captures from the fresh `final1057` run (admin people/members, new chat, team queue, access removal); older phone capture requires recapture after transition settles. Fake-model text is test scaffolding.

| # | Severity | Journey / step | Finding | Suggested fix | Where |
|---|---|---|---|---|---|
| UX1 | high, resolved | `artifacts/06-member-removal/02-bob-after-removal.png` | Removed team chat disappears from sidebar, but its content and enabled composer remain in the main pane. | Verify after settled revocation; clear the active route and show an access-removal explanation. | Hosted space reconciliation / active chat route |
| UX2 | medium, resolved | `artifacts/03-tool-files/02-file-preview.png` | File preview says “No project” and “Loading code…”. | Use “Chat files” and “Loading file…”. Integrated in `89fb36f07e`. | ChatView / DiffWorkerPoolProvider |
| UX3 | low, resolved | `artifacts/04-team-live-queue/03-alice-sees-queue.png` | The space badge leaves only “Draf…” for the active chat title. | Cap badge width or use a second line so titles remain distinguishable. | Flat chat sidebar |

Admin membership controls and the new-chat flow are coherent and aligned. Queue state identifies the author and exposes edit/steer/cancel actions clearly.
One high finding needs live verification; one medium wording fix is integrated.
Final browser, MCP, schedule and phone journeys still need review after integration.

### WP-H follow-up

- UX1 implementation `e68bcd0c6b`: leave a confirmed removed active space. Nine session/space tests pass; E2E now asserts the old URL and answer disappear. Live verification pending integrated deployment.
- UX2 capture helper now waits for the file text instead of capturing its initial loading screen.
- Phone helper waits until a closing drawer disappears before reopening it; repeat on integrated build.

These updates are intermediate evidence; final visual acceptance remains pending the integrated feature build.

## Round 2 — independent parent acceptance, 2026-10-23

Reviewed fresh full-resolution screenshots from `integrated1125` on the live deployment:

- **UX1 accepted:** `artifacts/06-member-removal/02-bob-after-removal.png` shows a fresh personal draft, no removed-space chat or content, and the notice “Access to this space was removed. You can continue in your personal space.” The associated live test observed socket revocation in 188 ms and UI transition in 3.5 s.
- **UX2 accepted:** `artifacts/03-tool-files/02-file-preview.png` shows the complete generated report under “Chat files”, with visible file navigation and download controls.
- **UX3 accepted:** `artifacts/04-team-live-queue/03-alice-sees-queue.png` now exposes “Draft the…” instead of “Draf…”, with a narrower space badge and the full title in the chat header. Queue authorship and edit/steer/cancel controls remain visible.
- **Phone drawer accepted:** `artifacts/12-phone/03-drawer.png` shows settled navigation with distinct titles, space badges, action menus and account controls, without overlap. The remaining settled phone screenshots (`02-home`, `04-chat`, `05-files`, `06-admin`) are also accepted: clear composer and space selection, usable chat actions, file drawer and admin tabs/cards without overlap. `01-login` was recaptured after the form settled and independently accepted: labelled fields, sign-in action and invitation guidance fit the phone viewport. Browser/MCP/scheduled-work journeys still require review.

## Round 3 — final feature walkthrough, 2026-10-23

- **MCP interaction accepted:** `artifacts/ux/wpf/mcp-choice.png` shows a rendered decision app, usable action buttons and “Shared with the assistant: Proceed” after the actual iframe click. The private integration loop separately verified that the choice reaches the next model turn.
- **UX4 — medium, resolved:** `artifacts/ux/wpf/schedule-create.png` and `schedule-create-phone.png` expose “Project”, “Create a new worktree” and “Base branch / From main” in the hosted task form. These controls do not fit the selected product scope. Fork `621339462a` removes those hosted controls and uses the managed workspace/configured model. Final desktop and 390 px form captures are independently accepted, and a new UI-created task ran through to an assistant response (“Sent by automation”). Both review tasks were deleted afterward.
- **Downloaded desktop accepted:** all 17 packaged-client checks pass against the final live version. `artifacts/desktop-release/desktop-chat.png` independently reviewed at full resolution: clear conversation, streamed reply, space badge and composer.

- **UX5 — medium, resolved:** final admin Health screenshot showed every active computer as “Computer unknown” and a zero running total. The view read `state`/`status`, but computerd returns `phase`. Fork `80bd6d1b1e` maps all six actual phase values and explicit errors (7 unit checks pass). Umbrella `6cc4fc2` also queries an existing computer from a cold cell's durable identity without booting T3 (3 lifecycle checks and platform typecheck pass). Final live check matched the actual ready computer, payload phase and UI count of 1; screenshot `artifacts/16-admin-health/01-real-computer-state.png` independently reviewed. It also showed 10 transient problem entries; a subsequent live check of all 34 spaces reported zero errors without intervention. Their original error reasons were not captured, so no definitive cause is claimed.
- **UX6 — high, resolved:** Browser15 showed Alice's live browser but Bob could not discover that existing tab after joining. Fork `fa1b4b3b89` restores shared browser surfaces from the first authoritative snapshot for hosted clients, preserving locally closed tabs. Browser15 passed on `dfcca1f55b` in 1.1 minutes: Bob receives JPEG frames from the existing session, human ownership rejects agent navigation, users can hand off/release control, and membership removal closes the viewer socket and releases ownership. Parent independently reviewed all three final browser screenshots; state labels and handoff controls are visible.

## Round 4 — clean general walkthrough acceptance

Run `final1217` completed all six journeys without helper errors: admin onboarding (41 s), member first chat (20 s), team collaboration (28 s), file round-trip (19 s), schedule setup (9 s), and phone layout (31 s). Parent independently reviewed final team queue, file preview, expanded phone composer and settled Health captures. Controls, authorship, file navigation and phone layout are coherent. The fake model's attachment-derived title is fixture text, not a production-title claim. `16-admin-health/02-settled-zero-problems.png` confirms zero problems after the transient earlier sample.

All six findings now have final acceptance evidence. The intervening provider-session startup failure was fixed by explicit managed OpenCode v2 selection (`5a75cfd7d2`), with 10 focused tests and provider typecheck passing. Browser15 and all three real-model checks passed after that deployment. No unresolved high or medium findings remain from these reviewed journeys.
