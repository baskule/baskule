import {
  act,
  useLayoutEffect,
  useImperativeHandle,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { HighlightNativeReviewDiffVisibleRowsInput } from "./nativeReviewDiffHighlighter";
import type { NativeReviewDiffViewProps } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffData } from "../review/nativeReviewDiffAdapter";

const mocks = vi.hoisted(() => ({
  registrationFailures: 0,
  tokenAccepted: true as boolean | undefined,
  tokenCompletion: null as Promise<boolean> | null,
  onDebug: undefined as NativeReviewDiffViewProps["onDebug"],
  autoViewport: false,
  contentResetKeyLandsLate: false,
  rows: vi.fn(),
  tokens: vi.fn(),
  highlight: vi.fn(),
}));

function RawView({
  ref: nativeRef,
  onDebug,
  initialFileId,
  contentResetKey = "",
}: NativeReviewDiffViewProps & { ref: Ref<unknown> }) {
  const [content, setContent] = useState({ resetKey: contentResetKey, rows: "" });
  // Native setContentResetKey clears rows unless the key is unchanged.
  const setContentResetKey = (resetKey: string) =>
    setContent((current) => (current.resetKey === resetKey ? current : { resetKey, rows: "" }));
  const [tokenRowIds, setTokenRowIds] = useState<string[]>([]);
  // Android Fabric can apply a prop update after an AsyncFunction call made later.
  if (!mocks.contentResetKeyLandsLate && content.resetKey !== contentResetKey) {
    setContentResetKey(contentResetKey);
  }
  useLayoutEffect(() => {
    mocks.onDebug = onDebug;
  });
  useImperativeHandle(nativeRef, () => ({
    async setRowsJson(value: string, resetKey?: string) {
      mocks.rows(value);
      if (mocks.registrationFailures > 0) {
        mocks.registrationFailures -= 1;
        throw new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag");
      }
      if (resetKey !== undefined) setContentResetKey(resetKey);
      setContent((current) => ({ ...current, rows: value }));
      setContentResetKey(contentResetKey);
      if (mocks.autoViewport) {
        const decoded = JSON.parse(value) as NativeReviewDiffData["rows"];
        onDebug?.({
          nativeEvent: { message: "rows-decoded", rows: decoded.length },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
        const index = decoded.findIndex(
          (row) => row.kind === "file" && row.fileId === initialFileId,
        );
        onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex: Math.max(0, index),
            lastRowIndex: Math.max(0, index) + 40,
            totalRows: decoded.length,
          },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
      }
    },
    async scrollToFile() {},
    async setTokensPatchJson(value: string) {
      mocks.tokens(value);
      const accepted = mocks.tokenCompletion ? await mocks.tokenCompletion : mocks.tokenAccepted;
      if (accepted === true) {
        const patch = JSON.parse(value);
        setTokenRowIds((current) => [
          ...new Set([...current, ...Object.keys(patch.tokensByRowId)]),
        ]);
      }
      return accepted;
    },
  }));
  return (
    <div data-token-rows={tokenRowIds.join(",")}>
      {content.rows ? "Rendered diff" : "Blank native surface"}
    </div>
  );
}

vi.mock("expo", () => ({ requireNativeView: () => RawView }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({
    title,
    actionLabel,
    onAction,
  }: {
    title: string;
    actionLabel: string;
    onAction: () => void;
  }) => (
    <div>
      {title}
      <button onClick={onAction}>{actionLabel}</button>
    </div>
  ),
}));
vi.mock("./nativeReviewDiffHighlighter", () => ({
  highlightNativeReviewDiffVisibleRows: mocks.highlight,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  settlePromise: async (execute: () => Promise<unknown>) => {
    try {
      return AsyncResult.success(await execute());
    } catch (error) {
      return AsyncResult.failure(Cause.die(error));
    }
  },
  squashAtomCommandFailure: () => "tokenization failed",
}));
vi.mock("../review/nativeReviewDiffAdapter", () => ({ createNativeReviewDiffTheme: () => ({}) }));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({ nativeReviewDiffStyle: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light", themeId: "test" }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));

import { resolveNativeReviewDiffView } from "./nativeReviewDiffSurface";

function setup(integrated = false) {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.registrationFailures = 0;
  mocks.tokenAccepted = true;
  mocks.tokenCompletion = null;
  mocks.onDebug = undefined;
  mocks.autoViewport = false;
  mocks.contentResetKeyLandsLate = false;
  mocks.rows.mockClear();
  mocks.tokens.mockClear();
  mocks.highlight
    .mockReset()
    .mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
      const rowId = `r${input.firstRowIndex}`;
      const tokensByRowId = input.alreadyHighlightedRowIds?.has(rowId)
        ? {}
        : { [rowId]: [{ content: "const", color: "#ff0000", fontStyle: null }] };
      return {
        rowCount: Object.keys(tokensByRowId).length,
        durationMs: 0,
        retryableRowIds: [],
        tokensByRowId,
      };
    });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const expo = Object.getOwnPropertyDescriptor(globalThis, "expo");
  Object.defineProperty(globalThis, "expo", {
    configurable: true,
    value: { getViewConfig: () => ({}) },
  });
  const NativeDiff = resolveNativeReviewDiffView()!;
  const container = document.createElement("div");
  const root = createRoot(container);
  if (!integrated) {
    act(() =>
      root.render(
        <NativeDiff
          rowsJson="[]"
          tokensPatchJson='{"tokensByRowId":{}}'
          appearanceScheme="light"
          themeJson="{}"
          rowHeight={20}
          contentWidth={300}
        />,
      ),
    );
  }
  return {
    container,
    get tokenRows() {
      return container.querySelector("[data-token-rows]")?.getAttribute("data-token-rows");
    },
    async showSection(contentResetKey: string) {
      await act(async () =>
        root.render(
          <NativeDiff
            rowsJson='[{"kind":"line","id":"r0"}]'
            contentResetKey={contentResetKey}
            appearanceScheme="light"
            themeJson="{}"
            rowHeight={20}
            contentWidth={300}
          />,
        ),
      );
    },
    async jump(firstRowIndex: number, totalRows = 1000) {
      await act(async () => {
        mocks.onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex,
            lastRowIndex: firstRowIndex + 40,
            totalRows,
          },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    async deliverPayloads() {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => {
        for (const callback of callbacks) callback(0);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    retry() {
      const button = container.querySelector("button");
      expect(button?.textContent).toBe("Retry diff");
      act(() => button!.click());
    },
    decodeFailure() {
      act(() =>
        mocks.onDebug?.({
          nativeEvent: { message: "rows-decode-failed", error: "Decode failed" },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      errors.mockRestore();
      vi.useRealTimers();
      if (expo) Object.defineProperty(globalThis, "expo", expo);
      else Reflect.deleteProperty(globalThis, "expo");
    },
  };
}

it("retries transient native registration without replacing the diff with an error", async () => {
  using screen = setup();
  mocks.registrationFailures = 1;
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Blank native surface");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("renders identical rows after switching sections when the reset key prop lands late", async () => {
  using screen = setup(true);
  await screen.showSection("thread:git:changes");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");

  mocks.contentResetKeyLandsLate = true;
  await screen.showSection("thread:git:working-tree");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("recognizes registration races for the installed native view name", async () => {
  const { isPendingNativeViewRegistration } = await import("./nativeReviewDiffSurface");

  expect(
    isPendingNativeViewRegistration(
      new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag"),
    ),
  ).toBe(true);
  expect(
    isPendingNativeViewRegistration(
      new Error("Unable to find the 'T3ReviewDiffView' view for this native tag"),
    ),
  ).toBe(false);
  expect(
    isPendingNativeViewRegistration(
      new Error(
        "Unable to find the class expo.modules.t3reviewdiff.T3ReviewDiffView view with tag 1150",
      ),
    ),
  ).toBe(true);
});
