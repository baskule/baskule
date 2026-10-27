// baskule: the right panel offers the chat's Files, and in the hosted 0.2 build the shared Browser
// (thin-server scope 6: the space computer's browser, shown when the space supports it). No
// terminal, diff, PR or device surfaces. Applied to RightPanelTabs' action lists, so the JSX and
// the props stay upstream's.
import { BASKULE_HOSTED, BASKULE_UI } from "./flags";

const SURFACES: ReadonlySet<string> = new Set(BASKULE_HOSTED ? ["Files", "Browser"] : ["Files"]);

export function baskuleSurfaceActions<T extends { readonly label: string }>(
  actions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return BASKULE_UI ? actions.filter((action) => SURFACES.has(action.label)) : actions;
}
