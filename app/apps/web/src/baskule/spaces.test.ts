import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as environment from "@t3tools/client-runtime/environment";
import { __setBaskuleMeForTests, readBaskuleMe } from "./session";
import {
  activeSpaceWasRemoved,
  buildRegistrations,
  groupThreadsBySpace,
  orderEnvironmentsBySpace,
  primarySpaceEnvironmentId,
  spaceRegistration,
} from "./spaces";

const team = { id: "team", name: "Team", kind: "team", role: "member", base: "/s/team" } as const;
const personal = {
  id: "personal",
  name: "Personal",
  kind: "personal",
  role: "owner",
  base: "/s/personal",
} as const;
const previous = [
  { space: team, environmentId: EnvironmentId.make("team-env") },
  { space: personal, environmentId: EnvironmentId.make("personal-env") },
];

describe("Run on space order", () => {
  const acme = { ...team, id: "acme", name: "Acme", base: "/s/acme" };
  const lab = { ...team, id: "lab", name: "Lab", base: "/s/lab" };
  const memberships = [personal, acme, lab].map((space) => ({
    space,
    environmentId: EnvironmentId.make(`${space.id}-env`),
  }));

  it("keeps Personal then team membership order for every connection arrival order", () => {
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const options = order.map((index, arrival) => ({
        environmentId: memberships[index]!.environmentId,
        isPrimary: arrival === 0,
        label: memberships[index]!.space.name,
      }));
      const original = [...options];
      expect(orderEnvironmentsBySpace(options, memberships).map((option) => option.label)).toEqual([
        "Personal",
        "Acme",
        "Lab",
      ]);
      expect(options).toEqual(original);
    }
  });

  it("keeps available teams in membership order while Personal is disconnected", () => {
    const options = [memberships[2]!, memberships[1]!];
    expect(orderEnvironmentsBySpace(options, memberships)).toEqual([
      memberships[1],
      memberships[2],
    ]);
    expect(orderEnvironmentsBySpace([], memberships)).toEqual([]);
  });
});

it("keeps Personal primary when a team registers first, waiting until Personal is registered", () => {
  const registered = new Map([[previous[0]!.environmentId, {}]]);
  expect(primarySpaceEnvironmentId(previous, registered)).toBeNull();
  registered.set(previous[1]!.environmentId, {});
  expect(primarySpaceEnvironmentId(previous, registered)).toBe(previous[1]!.environmentId);
  expect(primarySpaceEnvironmentId([], registered)).toBeNull();
});

describe("space discussion groups", () => {
  it("uses membership order and keeps the existing order within each space", () => {
    const threads = [
      { id: "personal-new", environmentId: previous[1]!.environmentId },
      { id: "team-new", environmentId: previous[0]!.environmentId },
      { id: "personal-old", environmentId: previous[1]!.environmentId },
      { id: "team-old", environmentId: previous[0]!.environmentId },
    ];
    expect(groupThreadsBySpace(threads, previous).map((thread) => thread.id)).toEqual([
      "team-new",
      "team-old",
      "personal-new",
      "personal-old",
    ]);
    expect(threads[0]!.id).toBe("personal-new");
  });

  it("keeps discussions while a space's registration is temporarily missing", () => {
    const threads = [
      { id: "waiting", environmentId: EnvironmentId.make("waiting-env") },
      { id: "personal", environmentId: previous[1]!.environmentId },
    ];
    expect(groupThreadsBySpace(threads, previous).map((thread) => thread.id)).toEqual([
      "personal",
      "waiting",
    ]);
    expect(groupThreadsBySpace([], previous)).toEqual([]);
  });
});

describe("revoked active space", () => {
  it("leaves an open chat when its space is removed", () => {
    expect(activeSpaceWasRemoved(previous, [personal], "/team-env/chat-id")).toBe(true);
  });
  it("keeps an allowed space even if its server is unreachable", () => {
    expect(activeSpaceWasRemoved(previous, [personal, team], "/team-env/chat-id")).toBe(false);
  });
  it("does not disturb another space or an admin page", () => {
    expect(activeSpaceWasRemoved(previous, [personal], "/personal-env/chat-id")).toBe(false);
    expect(activeSpaceWasRemoved(previous, [personal], "/admin")).toBe(false);
  });
});

it("keeps desktop HTTP on the bundled scheme and sockets on the hosted installation", () => {
  const registration = spaceRegistration(
    "baskule://app",
    team,
    EnvironmentId.make("team-env"),
    "https://cloud.example",
  );
  expect(registration.target.httpBaseUrl).toBe("baskule://app/s/team/");
  expect(registration.target.wsBaseUrl).toBe("wss://cloud.example/s/team/");
  expect(
    spaceRegistration("https://cloud.example", team, EnvironmentId.make("team-env")).target
      .wsBaseUrl,
  ).toBe("wss://cloud.example/s/team/");
});

it("keeps space discovery within two requests while other requests are stalled", async () => {
  const previousMe = readBaskuleMe();
  const spaces = Array.from({ length: 4 }, (_, index) => ({
    ...team,
    id: `discovery-${index}`,
    base: `/s/discovery-${index}`,
  }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let active = 0,
    peak = 0;
  using _descriptor = vi
    .spyOn(environment, "fetchRemoteEnvironmentDescriptor")
    .mockImplementation(({ httpBaseUrl }) =>
      Effect.promise(async () => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) markStarted();
        await gate;
        active--;
        return {
          environmentId: EnvironmentId.make(httpBaseUrl),
          label: "Test",
          serverVersion: "test",
          platform: { os: "linux", arch: "x64" },
          capabilities: { repositoryIdentity: false },
        };
      }),
    );
  vi.stubGlobal("window", { location: { origin: "http://spaces.test", pathname: "/" } });
  __setBaskuleMeForTests({
    authentication: { mode: "authenticated", password: true, providers: [] },
    user: { id: "person", name: "Person", email: "person@example.test", role: "member" },
    organizationName: null,
    spaces,
    canCreateSpaces: false,
    voiceInput: false,
  });
  const registrations = Effect.runPromise(buildRegistrations);
  try {
    await started;
    release();
    expect(await registrations).toHaveLength(spaces.length);
    expect(peak).toBe(2);
  } finally {
    release();
    await registrations;
    __setBaskuleMeForTests(null);
    await Effect.runPromise(buildRegistrations);
    __setBaskuleMeForTests(previousMe);
    vi.unstubAllGlobals();
  }
});
