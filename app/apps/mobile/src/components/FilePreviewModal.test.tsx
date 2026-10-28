import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type { AlertButton, AlertOptions } from "react-native";
import type { FilePreviewSource } from "./FilePreviewModal.types";

const native = vi.hoisted(() => ({
  alert:
    vi.fn<
      (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => void
    >(),
  open: vi.fn<() => Promise<void>>(),
  share: vi.fn<(input: { uri: string; signal: AbortSignal }) => Promise<void>>(),
  resolving: null as Promise<void> | null,
  files: new Map<string, string>(),
  owners: new Map<string, AbortSignal>(),
  invalidators: new Map<AuthEnvironmentScope, Set<() => void>>(),
}));

vi.mock("../i18n", () => ({ useTranslation: () => (text: string) => text }));
vi.mock("react-native", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("react-native-image-viewing", () => ({
  default: ({ images }: { images: { uri: string }[] }) => (
    <div>
      {images.map((image) => (
        <img key={image.uri} src={image.uri} />
      ))}
    </div>
  ),
}));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("./ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/Dialog", () => ({ alert: native.alert }));
vi.mock("./MediaImagePreview", () => ({ MediaImagePreview: () => null }));
vi.mock("./PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  openAttachmentInViewer: native.open,
  shareLocalAttachment: native.share,
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "No compatible viewer",
  managedAttachmentOwner: (uri: string) => {
    const signal = native.owners.get(uri);
    return signal ? { signal } : null;
  },
}));
vi.mock("../state/assets", async () => {
  const { useEffect } = await import("react");
  return {
    refreshAssetUrl: async (_environment: unknown, _resource: unknown, signal: AbortSignal) => {
      await native.resolving;
      if (signal.aborted) return null;
      const uri = "file:///protected/private.bin";
      native.files.set(uri, "private document bytes");
      native.owners.set(uri, signal);
      signal.addEventListener(
        "abort",
        () => {
          native.files.delete(uri);
          native.owners.delete(uri);
        },
        { once: true },
      );
      return uri;
    },
    useAssetConnectionLifetime: (
      environmentId: EnvironmentId | null,
      invalidate: () => void,
      scope: AuthEnvironmentScope,
    ) => {
      useEffect(() => {
        if (environmentId === null) return;
        const listeners = native.invalidators.get(scope) ?? new Set<() => void>();
        listeners.add(invalidate);
        native.invalidators.set(scope, listeners);
        return () => {
          listeners.delete(invalidate);
        };
      }, [environmentId, scope, invalidate]);
    },
  };
});

import { FilePreviewModal } from "./FilePreviewModal";

const resource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread:preview"),
  path: "/workspace/private.bin",
} as const;
const protectedSource = {
  kind: "document",
  environmentId: EnvironmentId.make("environment:preview"),
  resource,
  name: "private.bin",
} as const;
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.alert.mockClear();
  native.open.mockReset().mockRejectedValue(new Error("No compatible viewer"));
  native.share.mockReset().mockResolvedValue();
  native.resolving = null;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  native.files.clear();
  native.owners.clear();
  native.invalidators.clear();
  vi.unstubAllGlobals();
});

async function present(source: FilePreviewSource) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  function Presentation() {
    const [current, setCurrent] = useState<FilePreviewSource | null>(source);
    return <FilePreviewModal source={current} onRequestClose={() => setCurrent(null)} />;
  }
  await act(async () => root.render(<Presentation />));
  return container;
}

it("retains protected bytes through native-open failure and the delayed Save/share choice", async () => {
  const shared: string[] = [];
  const sharing = Promise.withResolvers<void>();
  native.share.mockImplementation(async ({ uri, signal }) => {
    expect(signal.aborted).toBe(false);
    expect(native.files.has(uri)).toBe(true);
    await sharing.promise;
    shared.push(native.files.get(uri)!);
  });
  const container = await present(protectedSource);
  const alert = native.alert.mock.lastCall;
  expect(alert?.[0]).toBe("Could not open preview");
  const save = alert?.[2]?.find((button) => button.text === "Save or share");
  expect(save).toBeDefined();
  await act(async () => {
    save?.onPress?.();
  });
  act(() => alert?.[3]?.onDismiss?.());
  expect(container.textContent).toContain("Opening document");
  expect(native.files.size).toBe(1);
  await act(async () => sharing.resolve());
  expect(shared).toEqual(["private document bytes"]);
  expect(container.textContent).toBe("");
  expect(native.files.size).toBe(0);
});

it("releases a failed native preview when its alert is cancelled", async () => {
  const container = await present(protectedSource);
  const cancel = native.alert.mock.lastCall?.[2]?.find((button) => button.text === "Cancel");
  expect(cancel).toBeDefined();
  await act(async () => {
    cancel?.onPress?.();
  });
  expect(container.textContent).toBe("");
  expect(native.files.size).toBe(0);
  expect(native.share).not.toHaveBeenCalled();
});

it.each([false, true])(
  "closes a mixed gallery on filesystem revocation during resolution=%s",
  async (resolving) => {
    const pending = Promise.withResolvers<void>();
    if (resolving) native.resolving = pending.promise;
    const opening = { kind: "image", uri: "https://example.test/public.png" } as const;
    const container = await present({
      ...opening,
      gallery: [opening, { ...protectedSource, kind: "image" }],
    });
    if (!resolving) expect(container.querySelectorAll("img")).toHaveLength(2);
    await act(async () => {
      for (const invalidate of native.invalidators.get(AuthFilesystemReadScope) ?? []) invalidate();
    });
    await act(async () => pending.resolve());
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(native.files.size).toBe(0);
  },
);
