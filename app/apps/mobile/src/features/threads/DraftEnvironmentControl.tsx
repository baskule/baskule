import { useGT } from "gt-react-native";
import { Pressable } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { BASKULE_FLAGS } from "../../baskule/flags";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  const gt = useGT();
  const disconnected = props.connectionState !== "connected";
  const status = disconnected ? gt("Offline") : gt("Connected");
  const { label } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        BASKULE_FLAGS.projects
          ? gt("Choose environment, {label}, {status}", { label, status })
          : gt("Choose space, {label}, {status}", { label, status })
      }
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      {BASKULE_FLAGS.projects ? (
        <EnvironmentMachineSymbol
          kind={props.machineKind}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      ) : null}
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        {BASKULE_FLAGS.projects ? gt("on {label}", { label }) : gt("in {label}", { label })}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}
