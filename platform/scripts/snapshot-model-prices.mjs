#!/usr/bin/env node
// Regenerate the built-in providers' prices, the model catalog's offline fallback; USD per million tokens.
import { writeFile } from "node:fs/promises";
const response = await fetch("https://models.dev/api.json");
if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
const catalog = await response.json();
const providers = Object.fromEntries(["mistral", "openai", "anthropic"].map(provider => [provider,
  Object.fromEntries(Object.entries(catalog[provider].models).filter(([, m]) => m.cost).map(([id, m]) => [id, m.cost])),
]));
await writeFile(new URL("../src/control/data/model-prices.json", import.meta.url), JSON.stringify({ fetchedAt: new Date().toISOString(), providers }, null, 2) + "\n");
