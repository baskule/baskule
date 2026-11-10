import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { newChatEnvironmentId, resolveNewChatEnvironment } from "./personal-environment-selection";

const personal = { kind: "personal", environmentId: EnvironmentId.make("personal") } as const;
const team = { kind: "team", environmentId: EnvironmentId.make("team") } as const;

describe("new chat destination", () => {
  it("waits for Personal rather than selecting a ready team", () => {
    expect(newChatEnvironmentId({ kind: "default-personal" }, [team])).toBeNull();
    expect(newChatEnvironmentId({ kind: "default-personal" }, [team, personal])).toBe(
      personal.environmentId,
    );
  });
  it("retains an explicit team even while its projects or descriptor are unavailable", () => {
    const selection = { kind: "explicit", environmentId: team.environmentId } as const;
    expect(newChatEnvironmentId(selection, [])).toBe(team.environmentId);
    expect(newChatEnvironmentId(selection, [personal, team])).toBe(team.environmentId);
  });

  const scratch = { scratchWorkspaceRoot: "/scratch" };
  const serverConfigs = new Map([
    [personal.environmentId, scratch],
    [team.environmentId, scratch],
  ]);
  const connected = (id: string) => ({
    environmentId: EnvironmentId.make(id),
    connectionState: "connected" as const,
  });
  const offline = (id: string) => ({
    environmentId: EnvironmentId.make(id),
    connectionState: "offline" as const,
  });
  it.each([
    [
      "Personal without a chosen space",
      null,
      [connected("personal"), connected("team")],
      "ready",
      "personal",
    ],
    ["the chosen team", "team", [connected("personal"), connected("team")], "ready", "team"],
    [
      "an offline chosen team, never Personal",
      "team",
      [connected("personal"), offline("team")],
      "unavailable",
      "team",
    ],
    [
      "offline Personal, never a ready team",
      null,
      [offline("personal"), connected("team")],
      "unavailable",
      "personal",
    ],
    [
      "Personal for a space that no longer exists",
      "gone",
      [connected("personal")],
      "ready",
      "personal",
    ],
  ] as const)("starts in %s", (_, selected, environments, kind, environmentId) => {
    expect(
      resolveNewChatEnvironment({
        selectedEnvironmentId: selected === null ? null : EnvironmentId.make(selected),
        spaces: [personal, team],
        environments,
        serverConfigs,
      }),
    ).toEqual({ kind, environmentId: EnvironmentId.make(environmentId) });
  });
  it("waits while the spaces are still loading", () => {
    expect(
      resolveNewChatEnvironment({
        selectedEnvironmentId: null,
        spaces: [],
        environments: [],
        serverConfigs,
      }),
    ).toEqual({ kind: "unavailable", environmentId: null });
  });
});
