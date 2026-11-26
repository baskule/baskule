import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectServerUpdateTargets, type UpdateEverythingMachine } from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        minClient: "0.0.0",
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

// A desktop-mode server the desktop app cannot control, such as a WSL backend or an older app.
function withoutDesktopControl(base: UpdateEverythingMachine): UpdateEverythingMachine {
  return {
    ...base,
    serverConfig: {
      ...base.serverConfig!,
      environment: {
        ...base.serverConfig!.environment,
        capabilities: { repositoryIdentity: true, serverSelfUpdate: "desktop-managed" },
      },
    },
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
        withoutDesktopControl(machine("wsl-backend", "0.0.40", "desktop-managed")),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "still loading"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
      ["wsl-backend", "update T3 Code on that machine"],
    ]);
  });

  it("says why a disconnected server was skipped when its connection says", () => {
    const replaced =
      "This address now runs a different T3 Code install (b7a4, not 0359). Remove this connection and add it again.";
    const { skipped } = collectServerUpdateTargets(
      [
        machine("replaced", "0.0.40", "boot-service", {
          connected: false,
          serverConfig: null,
          connectionError: replaced,
        }),
        machine("silent", "0.0.40", "boot-service", { connected: false, connectionError: null }),
        machine("switched-off", "0.0.40", "boot-service", {
          connected: false,
          serverConfig: null,
          turnedOff: true,
        }),
      ],
      "0.0.50",
    );

    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["replaced", replaced],
      ["silent", "not connected"],
      ["switched-off", "turned off"],
    ]);
  });

  it("does not offer a Nightly build to a Stable desktop app, whose own feed has nothing newer", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [machine("stable-desktop", "0.1.9", "desktop-managed")],
      "0.1.10-nightly.20261116.4761",
    );

    expect(targets.map((target) => target.serverLabel)).toEqual([]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["stable-desktop", "on the stable channel"],
    ]);
  });

  it("skips servers whose policy refuses the update, with the policy's message", () => {
    const managed = (
      id: string,
      updates: { mode: "off" } | { mode: "auto"; allowNightly: false },
      selfUpdate: "boot-service" | "desktop-managed" = "boot-service",
    ) => {
      const base = machine(id, "0.0.40", selfUpdate);
      return {
        ...base,
        serverConfig: {
          ...base.serverConfig!,
          managedPolicy: { organization: "Example Corp", lockedSettings: [], limits: { updates } },
        },
      };
    };
    const machines = [
      managed("off", { mode: "off" }),
      managed("no-nightly", { mode: "auto", allowNightly: false }),
      // A desktop app updates from its own feed, whatever track this app is on.
      managed("desktop-no-nightly", { mode: "auto", allowNightly: false }, "desktop-managed"),
    ];

    expect(
      collectServerUpdateTargets(machines, "0.0.50").skipped.map((entry) => [
        entry.label,
        entry.reason,
      ]),
    ).toEqual([["off", "Example Corp manages T3 Code updates."]]);
    expect(
      collectServerUpdateTargets(
        machines.map((entry) => ({
          ...entry,
          serverConfig: {
            ...entry.serverConfig,
            environment: {
              ...entry.serverConfig.environment,
              serverVersion: "0.0.49-nightly.20261027.1",
            },
          },
        })),
        "0.0.50-nightly.20261028.1",
      ).skipped.map((entry) => entry.label),
    ).toEqual(["off", "no-nightly"]);
  });
});
