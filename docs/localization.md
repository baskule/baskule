# Localization

Baskule uses General Translation for the web, mobile, and desktop interfaces. The
language setting belongs to the device. **Use system language** selects the first
supported language from the device's preferences and falls back to English.

## Mark interface copy

In React, use `<T>` for JSX content and `useGT()` for string props and interpolated
labels. Use `msg()` to mark shared messages and `useMessages()` to resolve them in a
component. Outside React, pass marked messages to the app's `m()` resolver. Follow
the patterns in the app that owns the UI.

Use complete messages and name the variables. Use ICU plurals so translators can
choose the plural forms their languages require.

```tsx
gt("Archive {title}?", { title });
gt("{count, plural, one {# chat selected} other {# chats selected}}", { count });
```

Keep **Baskule**, **OpenCode**, commands, filenames, URLs, model identifiers, and
user-provided text as written. A **space** is a personal or team workspace on the
installation. A **chat** is a conversation with an agent. Use the same terms across
the interface, including short action labels and accessibility announcements.

## Update catalogs in the same pull request

After [toolchain setup](building.md), run `pnpm exec vp run i18n:generate` in each
affected app directory under `app/apps/`. The command extracts the English source
into the app's `src/i18n/translations/en.json`. The app's `gt.config.json` lists the
target locales.

Translate every new key in every target catalog. Keep ICU variable names and JSX
placeholder identifiers intact. Match the catalog's JSX structure where the
message contains markup. Review punctuation, plural forms, and whether the copy
fits its control. The mobile app sources iOS permission descriptions from the
same catalogs. A new permission description ships in a new native build.

Run the catalog check from `app/`.

```sh
source scripts/env.sh
cd app
pnpm exec vp run i18n:check
```

CI runs the same check. Extraction, validation, and builds use checked-in
catalogs and require no translation service credentials.
