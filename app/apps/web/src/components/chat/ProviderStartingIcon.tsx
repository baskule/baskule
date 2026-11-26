import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { providerInstanceEntriesFor } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

interface ProviderStartingPresentation {
  readonly displayName: string;
}

// Keyed per instance so provider status pushes don't rerender the live row.
const providerStartingPresentationAtom = Atom.family((key: string) =>
  Atom.make((get): ProviderStartingPresentation | null => {
    const [environmentId, instanceId] = key.split("\u0000") as [string, string];
    const config = get(serverEnvironment.configValueAtom(environmentId as EnvironmentId));
    const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
    if (!config || !provider) return null;
    const [entry] = providerInstanceEntriesFor([provider], config.settings, null);
    if (!entry) return null;
    const next = {
      displayName: entry.displayName,
    };
    const previous = Option.getOrNull(get.self<ProviderStartingPresentation | null>());
    return previous && previous.displayName === next.displayName ? previous : next;
  }).pipe(Atom.withLabel("provider-starting-presentation")),
);

/** The logo of the provider a run is waiting on, shown in place of the thinking icon. */
export function ProviderStartingIcon(props: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}) {
  const presentation = useAtomValue(
    providerStartingPresentationAtom(`${props.environmentId ?? ""}\u0000${props.instanceId}`),
  );
  return (
    <ProviderInstanceIcon
      driverKind={props.driver}
      displayName={presentation?.displayName ?? PROVIDER_DISPLAY_NAMES[props.driver] ?? ""}
      className="z-auto"
      iconClassName="size-4"
    />
  );
}
