import { t } from "../i18n";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";

export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  get server() {
    return t("Server");
  },
  get cloud() {
    return t("Cloud VM");
  },
  get linux() {
    return t("Linux/WSL");
  },
  get desktop() {
    return t("Desktop");
  },
  get laptop() {
    return t("Laptop");
  },
  get "mac-mini"() {
    return t("Mini PC");
  },
  get "mac-studio"() {
    return t("Workstation");
  },
};

export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
