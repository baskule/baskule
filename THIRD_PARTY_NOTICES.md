# Third-party notices

Baskule's original code is licensed under the [MIT license](LICENSE).
Retained third-party code and assets keep their respective licenses and notices.

- `app/` is derived from [T3 Code](https://github.com/pingdotgg/t3code), copyright T3 Tools Inc., under its [MIT license](app/LICENSE).
- `deploy/celld/patches/` contains changes to [celld](https://github.com/denoland/celld), copyright Deno Land Inc., under its [Apache-2.0 license](deploy/celld/upstream-LICENSE). Its [notices](deploy/celld/upstream-NOTICE) and the official runtime image's license files are retained.
- `platform/src/control/plugins/` adapts the plugin marketplace parsing, completeness rules, category and recommendation tables, and the Composio and Pipedream integrations of [Rakazo](https://github.com/elie222/rakazo), copyright 2026 Rakazo contributors, under its [Apache-2.0 license](platform/src/control/plugins/rakazo-LICENSE). Adapted files say so in their first line.
- Nested notices for bundled libraries, fonts, native components and dependency archives remain with their source. Preserve them when redistributing those components.

[Source provenance](source-provenance.json) records the upstream sources and their licenses.
