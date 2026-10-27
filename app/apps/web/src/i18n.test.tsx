import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vite-plus/test";

import { activateLocale } from "@t3tools/shared/localization";

import { useTranslation } from "./i18n";

afterEach(() => activateLocale("en"));

it("returns the same translator on every render, so compiler caches survive re-renders", async () => {
  const seen: Array<ReturnType<typeof useTranslation>> = [];
  function Probe() {
    seen.push(useTranslation());
    return null;
  }
  renderToStaticMarkup(<Probe />);
  renderToStaticMarkup(<Probe />);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);

  // A translator retained by an effect still follows the current language.
  await activateLocale("fr");
  expect(seen[0]!("Working")).toBe("En cours");
});
