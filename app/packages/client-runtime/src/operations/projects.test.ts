import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDestinationPath,
  getCloneDirectoryLeafName,
  getCloneDirectoryPath,
  getCloneDirectoryName,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("lays clone folders out like ghq only when asked, and only when the URL is safe", () => {
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", false)).toBe("repo");
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", true)).toBe(
      "github.com/owner/repo",
    );
    expect(getCloneDirectoryPath("ssh://git@gitlab.com:2222/group/sub/repo.git", true)).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(getCloneDirectoryPath("https://github.com/owner/../../repo", true)).toBe("repo");
    expect(getCloneDirectoryPath("/srv/git/repo.git", true)).toBe("repo");
    expect(
      getCloneDirectoryPath(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        false,
        "Project/My Repo",
      ),
    ).toBe("My Repo");
    expect(
      getCloneDirectoryLeafName(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        true,
        "Project/My Repo",
      ),
    ).toBe("My%20Repo");
    expect(
      getCloneDestinationPath(
        "C:\\Users\\me\\ghq",
        getCloneDirectoryPath("git@github.com:owner/repo.git", true),
      ),
    ).toBe("C:\\Users\\me\\ghq\\github.com\\owner\\repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});
