// baskule: the right panel offers Files and Side chat, plus the shared Browser in hosted builds.
// Terminal, diff, PR and device surfaces stay hidden. Applied to RightPanelTabs' action lists, so the JSX and
// the props stay upstream's.
import { t } from "../i18n";
import { BASKULE_HOSTED, BASKULE_UI } from "./flags";

const SURFACES: ReadonlySet<string> = new Set(BASKULE_HOSTED ? ["Files", "Browser"] : ["Files"]);

export function baskuleSurfaceActions<T extends { readonly label: string }>(
  actions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return BASKULE_UI
    ? actions.filter((action) => SURFACES.has(action.label) || action.label === t("Side chat"))
    : actions;
}
