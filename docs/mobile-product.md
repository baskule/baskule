# Baskule mobile and upstream T3 Code

The Android and iOS apps share the React Native client in `app/apps/mobile/`. Baskule retains
T3's conversation runtime, navigation infrastructure and native modules, while presenting a
chat product backed by a Baskule installation. Keep that distinction explicit when updating
upstream code: a newly added entry point must respect the same product capabilities as web
and desktop.

## Product boundaries

[`baskule/flags.ts`](../app/apps/mobile/src/baskule/flags.ts) owns the mobile capability policy
and the supported route filter. Check both the visible control and alternate routes when
adapting an upstream feature. Hiding a menu item alone does not remove a deep link, command
palette entry or tablet sidebar action.

Projects, source-control workflows, terminals, execution modes and user-selected models are
outside the current mobile product. They remain internal upstream concepts where the runtime
needs them. In particular, a new chat still needs the selected space's scratch project and
the installation's configured model. Resolve those internally; do not route the person
through a project picker or silently move an unavailable team's draft to Personal.

The chat list is the mobile home. Settings are reached from its header, with ordinary Back
navigation. Existing spaces remain useful destinations for chats; upstream environment
administration and duplicate space-management links do not belong in mobile settings.

## Baskule additions

Account sessions, bearer-authenticated settings APIs and installation connection screens live
under [`src/baskule`](../app/apps/mobile/src/baskule). Native account settings use the existing
platform APIs and shared contracts. Password changes must retain the replacement signed bearer,
since revoking other sessions also replaces the current session. Plugin OAuth consent still
uses the system browser; listing and managing connected accounts is native.

Keep product-specific screens and helpers identifiable, and keep changes at upstream call
sites small. Fix shared lifecycle defects in the owning mobile module, as with microphone
permission handling, rather than cloning the conversation or voice runtime. Avoid a second
navigation system, parallel account store or fork-specific wire protocol.

## Updating upstream

When merging new T3 code, check new routes, composer actions, settings search entries,
platform-specific headers and tablet navigation against the capability policy. Preserve
upstream licenses and attribution. Run the relevant logic checks, then follow
[native mobile verification](mobile-verification.md) on the affected platforms. Native
fingerprints establish binary compatibility; they do not establish product or UI correctness.
