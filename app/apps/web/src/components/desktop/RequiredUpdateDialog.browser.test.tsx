import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { RequiredUpdateDialog } from "./RequiredUpdateDialog";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (state: DesktopUpdateState) => {
      mocks.update = state;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));

const available: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.5.1",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "0.5.2",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "You must update Baskule to 0.5.2 or newer to use this installation.",
  errorContext: null,
  canRetry: false,
  requiredVersion: "0.5.2",
};

function setup(update: DesktopUpdateState | null) {
  mocks.update = update;
}

describe("RequiredUpdateDialog", () => {
  it("stays open, downloads then installs from one button, and recovers a failed install", async () => {
    setup(available);
    const downloaded: DesktopUpdateState = {
      ...available,
      status: "downloaded",
      downloadedVersion: "0.5.2",
      downloadPercent: 100,
      message: null,
    };
    let finishDownload = () => {};
    const downloadFinished = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    const steps: string[] = [];
    const downloadUpdate = vi.fn(async () => {
      steps.push("download");
      mocks.push({ ...available, status: "downloading", downloadPercent: 42, message: null });
      await downloadFinished;
      mocks.push(downloaded);
      return { accepted: true, completed: true, state: downloaded };
    });
    const installUpdate = vi.fn(async () => {
      steps.push("install");
      return { accepted: true, completed: false, state: downloaded };
    });
    using _bridge = stubGlobal("desktopBridge", {
      downloadUpdate,
      installUpdate,
      getBaskuleServer: () => "https://baskule.example.com",
    });
    await using _screen = await render(<RequiredUpdateDialog />);

    await expect.element(page.getByRole("alertdialog", { name: "Update required" })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "baskule.example.com requires Baskule 0.5.2 or newer. This app is version 0.5.1.",
        ),
      )
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    const button = page.getByRole("button", { name: "Update and restart" });
    await expect.element(button).toBeVisible();

    await userEvent.click(button);
    await expect
      .element(page.getByRole("button", { name: "Downloading update (42%)" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(installUpdate).not.toHaveBeenCalled();

    finishDownload();
    await expect.element(page.getByRole("button", { name: "Restarting…" })).toBeVisible();
    expect(steps).toEqual(["download", "install"]);
    expect(page.getByText("Update downloaded").query()).toBeNull();

    mocks.push({ ...downloaded, errorContext: "install", message: "The installer exited." });
    await expect.element(page.getByText("The installer exited.")).toBeVisible();
    await expect.element(button).not.toHaveAttribute("aria-disabled");
  });

  it("keeps an install failure that arrives before the install call returns", async () => {
    const downloaded: DesktopUpdateState = {
      ...available,
      status: "downloaded",
      downloadedVersion: "0.5.2",
      downloadPercent: 100,
      message: null,
    };
    setup(downloaded);
    const installUpdate = vi.fn(async () => {
      mocks.push({ ...downloaded, errorContext: "install", message: "The installer exited." });
      await expect.element(page.getByText("The installer exited.")).toBeVisible();
      return { accepted: true, completed: false, state: downloaded };
    });
    using _bridge = stubGlobal("desktopBridge", { installUpdate });
    await using _screen = await render(<RequiredUpdateDialog />);

    const button = page.getByRole("button", { name: "Update and restart" });
    await userEvent.click(button);
    await vi.waitFor(() => expect(installUpdate).toHaveResolved());
    await expect.element(button).not.toHaveAttribute("aria-disabled");
    expect(page.getByRole("button", { name: "Restarting…" }).query()).toBeNull();
  });

  it("ignores a stale reply from an earlier install attempt", async () => {
    const downloaded: DesktopUpdateState = {
      ...available,
      status: "downloaded",
      downloadedVersion: "0.5.2",
      downloadPercent: 100,
      message: null,
    };
    setup(downloaded);
    let releaseFirst = () => {};
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const installUpdate = vi
      .fn()
      .mockImplementationOnce(async () => {
        mocks.push({ ...downloaded, errorContext: "install", message: "The installer exited." });
        await firstReleased;
        throw new Error("stale reply");
      })
      .mockImplementationOnce(async () => {
        mocks.push(downloaded);
        return { accepted: true, completed: false, state: downloaded };
      });
    using _bridge = stubGlobal("desktopBridge", { installUpdate });
    await using _screen = await render(<RequiredUpdateDialog />);

    const button = page.getByRole("button", { name: "Update and restart" });
    await userEvent.click(button);
    await expect.element(page.getByText("The installer exited.")).toBeVisible();
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Restarting…" })).toBeVisible();

    releaseFirst();
    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(installUpdate.mock.settledResults[0]?.type).toBe("rejected"));
    expect(page.getByText(/stale reply/).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Restarting…" })).toBeVisible();
  });
});
