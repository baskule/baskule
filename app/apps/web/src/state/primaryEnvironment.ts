import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { BASKULE_HOSTED } from "../baskule/flags";
import { primarySpaceEnvironmentId, readSpaceEnvironments } from "../baskule/spaces";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  const entries = get(environmentCatalog.catalogValueAtom).entries;
  if (BASKULE_HOSTED) return primarySpaceEnvironmentId(readSpaceEnvironments(), entries);
  for (const [environmentId, entry] of entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));
