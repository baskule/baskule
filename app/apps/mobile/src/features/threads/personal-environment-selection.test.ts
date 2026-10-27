import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { newChatEnvironmentId } from "./personal-environment-selection";

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
});
