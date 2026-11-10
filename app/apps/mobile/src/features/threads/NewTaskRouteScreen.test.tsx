import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

interface Share {
  readonly id: string;
  readonly attachments: ReadonlyArray<{ readonly type: "image" | "file" }>;
  readonly destination?: { readonly environmentId: string; readonly projectId: string };
}

const harness = vi.hoisted(() => ({
  share: null as Share | null,
  projects: [] as ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceRoot: string;
    readonly title: string;
  }>,
  connectionState: "connected" as string,
  destinationEnabled: false,
  loadedEnvironmentIds: ["env-1"],
  openScratch: vi.fn(),
  selectDetail: vi.fn(),
  releaseShareReservation: vi.fn(),
  navigation: {
    canGoBack: () => true,
    goBack: () => undefined,
    isFocused: () => true,
    getState: () => ({ routeNames: ["NewTaskProject"], routes: [], index: 0 }),
    getParent: () => undefined,
    dispatch: () => undefined,
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string) => ({ type: "PUSH", name }) },
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { title: string; actions?: ReadonlyArray<{ accessibilityLabel: string }> }) => (
    <header>
      {props.title}
      {props.actions?.map((action) => (
        <span key={action.accessibilityLabel}>{action.accessibilityLabel}</span>
      ))}
    </header>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button type="button" onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/NavigationRow", () => ({ NavigationRow: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/entities", () => ({
  useProjects: () => harness.projects,
  useServerConfigs: () => new Map([["env-1", { scratchWorkspaceRoot: "/scratch" }]]),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { environmentId?: string }) =>
    harness.loadedEnvironmentIds.includes(atom.environmentId ?? ""),
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { hasSnapshotAtom: (environmentId: string) => ({ environmentId }) },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.openScratch }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: "env-1", connectionState: harness.connectionState, isEnabled: true },
      ...(harness.destinationEnabled
        ? [{ environmentId: "env-2", connectionState: "connecting", isEnabled: true }]
        : []),
    ],
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({
    state: {
      isLoadingConnections: false,
      hasConnections: true,
      hasLoadedShellSnapshot: true,
      hasConnectingEnvironment: false,
      hasReadyEnvironment: true,
      connectionState: "available",
      connectionError: null,
    },
  }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({
    getShare: (id: string) => (harness.share?.id === id ? harness.share : null),
    releaseShareReservation: harness.releaseShareReservation,
  }),
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: [],
    selectedEnvironmentId: "env-1",
    setProject: vi.fn(),
  }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";

const scratch = {
  environmentId: "env-1",
  id: "scratch",
  workspaceRoot: "/scratch",
  title: "Scratch",
};

function setup(
  share: Share,
  options: { connectionState?: string; destinationEnabled?: boolean } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.share = share;
  harness.projects = [scratch];
  harness.connectionState = options.connectionState ?? "connected";
  harness.destinationEnabled = options.destinationEnabled ?? false;
  harness.loadedEnvironmentIds = ["env-1"];
  harness.openScratch.mockReset().mockResolvedValue({ _tag: "Success", value: scratch });
  harness.selectDetail.mockReset();
  harness.releaseShareReservation.mockReset().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(<NewTaskRouteScreen route={{ params: { incomingShareId: share.id } } as never} />),
  );
  return {
    container,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  harness.share = null;
});

it("starts shared content in the space's chat, without the project picker", async () => {
  using screen = setup({ id: "share-1", attachments: [{ type: "image" }] });
  expect(screen.container.textContent).not.toMatch(/Add project|Search projects|Choose project/);
  await vi.waitFor(() =>
    expect(harness.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: {
        draft: { environmentId: "env-1", projectId: "scratch", incomingShareId: "share-1" },
      },
    }),
  );
});

it("resumes a share's reserved chat instead of opening a new one", async () => {
  using _screen = setup({
    id: "share-2",
    attachments: [],
    destination: { environmentId: "env-1", projectId: "scratch" },
  });
  await vi.waitFor(() =>
    expect(harness.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: {
        draft: {
          environmentId: "env-1",
          projectId: "scratch",
          title: "Scratch",
          incomingShareId: "share-2",
        },
      },
    }),
  );
  expect(harness.openScratch).not.toHaveBeenCalled();
});

it("offers a new chat when a share's reserved chat is gone", async () => {
  const destination = { environmentId: "env-1", projectId: "deleted" };
  using screen = setup({ id: "share-3", attachments: [], destination });
  expect(harness.openScratch).not.toHaveBeenCalled();
  const button = [...screen.container.querySelectorAll("button")].find(
    (element) => element.textContent === "Start a new chat",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(harness.releaseShareReservation).toHaveBeenCalledWith("share-3", destination);
  expect(harness.selectDetail).toHaveBeenCalledWith({
    name: "Thread",
    params: {
      draft: { environmentId: "env-1", projectId: "scratch", incomingShareId: "share-3" },
    },
  });
});

it("explains an offline space instead of showing dead project controls", () => {
  using screen = setup({ id: "share-4", attachments: [] }, { connectionState: "disconnected" });
  expect(screen.container.textContent).toContain(
    "This space is not connected. Try again when it is back online.",
  );
  expect(screen.container.textContent).not.toMatch(/Add project|Search projects/);
  expect(harness.openScratch).not.toHaveBeenCalled();
});

it("waits for the reserved space even when another space already loaded", () => {
  using screen = setup(
    {
      id: "share-team",
      attachments: [],
      destination: { environmentId: "env-2", projectId: "team-chat" },
    },
    { destinationEnabled: true },
  );
  expect(screen.container.textContent).toContain("Starting a new chat…");
  expect(screen.container.textContent).not.toContain("no longer available");
  expect(screen.container.querySelector("button")).toBeNull();
  expect(harness.releaseShareReservation).not.toHaveBeenCalled();
  expect(harness.openScratch).not.toHaveBeenCalled();
});

it("offers recovery when the reserved space is no longer enabled", () => {
  using screen = setup({
    id: "share-removed",
    attachments: [],
    destination: { environmentId: "env-2", projectId: "team-chat" },
  });
  expect(screen.container.textContent).toContain("no longer available");
  expect(screen.container.querySelector("button")?.textContent).toBe("Start a new chat");
  expect(harness.releaseShareReservation).not.toHaveBeenCalled();
});
