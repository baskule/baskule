import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: state.get } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/projects", () => ({
  environmentProjects: { projectAtom: () => "project" },
  projectEnvironment: {},
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: vi.fn() }));
vi.mock("expo-haptics", () => ({}));
vi.mock("../../components/ui/Dialog", () => ({}));

import { canTurnThreadIntoProject } from "./turnThreadIntoProject";

it.each([
  { supported: false, scratch: true, folder: "/sandbox/chat", visible: false },
  { supported: true, scratch: true, folder: "/sandbox/chat", visible: true },
  { supported: true, scratch: false, folder: "/sandbox/project", visible: false },
  { supported: true, scratch: true, folder: null, visible: false },
])("shows project promotion only when the server permits it: %j", (input) => {
  const environmentId = EnvironmentId.make("environment-menu");
  state.get.mockImplementation((atom) =>
    atom === "configs"
      ? new Map([
          [
            environmentId,
            { environment: { capabilities: { threadProjectFromScratch: input.supported } } },
          ],
        ])
      : { isScratch: input.scratch },
  );
  expect(
    canTurnThreadIntoProject({
      environmentId,
      projectId: ProjectId.make("project-menu"),
      worktreePath: input.folder,
    }),
  ).toBe(input.visible);
});
