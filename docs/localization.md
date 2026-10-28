# Localization

Baskule has English, French, Spanish, German, Dutch, and Italian interface catalogs. The browser, Electron, or Expo locale list selects the first supported language. English is the fallback. The language setting offers an explicit override or **Use system language**. The preference belongs to the device.

## Source messages and catalogs

The clients use i18next. The bundled desktop renderer shares the web catalog. Use `t("Sign in")` for interface messages and the client's `useTranslation()` binding in React components. For a label that is also a model key, `msg("Working")` marks the source without changing its identity. Translate it at display time.

Use complete messages with named interpolation:

```ts
t("Archive {{title}}?", { title });
t("{{count}} chat selected", { count, defaultValue_other: "{{count}} chats selected" });
```

The generator extracts singular and plural forms. React renders interpolation as text. Do not translate enum values, CSS, URLs, commands, filenames, user content, AI responses, or embedded documents.

JSON catalogs are the editable input and the shared runtime input. The web client loads additional catalogs on demand; native clients bundle them.

## Generate translations

After [toolchain setup](building.md), extract source messages and validate catalogs:

```sh
source scripts/env.sh
node app/scripts/localization.ts extract
node app/scripts/localization.ts check
```

Translation uses a model provider and requires explicit credentials. Set `TRANSLATION_API_KEY` privately, then run:

```sh
node app/scripts/localization.ts translate --locale fr
```

`TRANSLATION_BASE_URL` and `TRANSLATION_MODEL` select the provider and model. Their defaults are in `app/scripts/localization.ts`. The request includes source messages, source locations, and the [product context and glossary](../app/scripts/localization-context.md). Runtime interpolation values and chat histories are not translation inputs.

Review generated changes before committing them. Valid entries are preserved. To retranslate changed terminology, remove the target entry and generate it again. Commit the JSON catalogs and generated native metadata files together.

The release workflow generates missing translations only for `v*` tags, using `TRANSLATION_API_KEY` from the `release` environment. The GitHub variables `TRANSLATION_MODEL` and `TRANSLATION_BASE_URL` optionally select the model and provider. Release builds share the generated catalogs and native metadata through the `translations` artifact. When catalogs change, the run pushes `translations/v<version>` and adds a compare/PR-create link to its summary. Merge that branch into `main` to keep catalogs committed and update the hosted site, which builds `main`. Pull request CI does not generate translations; manual factory runs use the committed catalogs without the key.

## Build clients

Client builds consume checked-in catalogs, or the release run's `translations` artifact, and require no translation model key at runtime. Provider diagnostics, remote tool results, and user content retain their original text.

Mobile builds include Expo Localization and generated iOS permission-description catalogs. Changes to native modules, navigation properties, or permission metadata require a new native build. A JavaScript update alone cannot add them. See [the mobile README](../app/apps/mobile/README.md).
