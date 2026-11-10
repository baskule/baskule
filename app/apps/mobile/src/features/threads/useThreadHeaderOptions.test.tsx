import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import type { VcsStatusResult } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  bar: null as AppBarProps | null,
  auxiliaryPaneVisible: false,
  toggleAuxiliaryPane: vi.fn(),
  openFiles: vi.fn(),
}));
vi.mock("../../i18n", () => ({ useTranslation: () => (text: string) => text }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: AppBarProps) => {
    harness.bar = props;
    return null;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    panes: { auxiliaryPaneVisible: harness.auxiliaryPaneVisible },
    toggleAuxiliaryPane: harness.toggleAuxiliaryPane,
    composerKeyboardActive: false,
    startNewTask: vi.fn(),
  }),
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => vi.fn(),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));

import { ThreadHeader } from "./ThreadHeader";

describe("Baskule thread header", () => {
  it.each([false, true])(
    "keeps files accessible and excludes Git and Terminal with an open files pane %s",
    (filesOpen) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      harness.auxiliaryPaneVisible = filesOpen;
      harness.openFiles.mockClear();
      harness.toggleAuxiliaryPane.mockClear();
      const root = createRoot(document.createElement("div"));
      using cleanup = { [Symbol.dispose]: () => act(() => root.unmount()) };
      const render = (gitStatus: VcsStatusResult | null) =>
        act(() =>
          root.render(
            <ThreadHeader
              title="Chat"
              subtitle=""
              hasThreadCwd
              inspectorMode={filesOpen ? "files" : null}
              onOpenFilesInspector={harness.openFiles}
              gitControls={{
                environmentId: "space",
                threadId: "thread",
                currentBranch: "main",
                gitStatus,
                gitOperationLabel: null,
                onPull: async () => {},
                onRunAction: async () => null,
                canOpenTerminal: true,
                canOperateTerminal: true,
                canOpenFiles: true,
                projectScripts: [],
                terminalSessions: [],
                onOpenTerminal: vi.fn(),
                onOpenNewTerminal: vi.fn(),
                onRunProjectScript: async () => {},
              }}
            />,
          ),
        );
      render(null);
      expect(harness.bar?.menus).toEqual([]);
      expect(harness.bar?.actions?.map((action) => action.accessibilityLabel)).toEqual([
        filesOpen ? "Close files" : "Open files",
      ]);
      harness.bar?.actions?.[0]?.onPress();
      expect(filesOpen ? harness.toggleAuxiliaryPane : harness.openFiles).toHaveBeenCalledOnce();
      render({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature",
        hasWorkingTreeChanges: true,
        hasUpstream: true,
        pr: null,
        aheadCount: 1,
        behindCount: 0,
        workingTree: { files: [], insertions: 1, deletions: 0 },
      });
      expect(harness.bar?.menus).toEqual([]);
      expect(harness.bar?.actions).toHaveLength(1);
    },
  );
});
