import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  listeners: [] as Array<() => boolean>,
}));
// The navigator-free hooks live in @react-navigation/core; the native package adds React Native linking.
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const nativeRequire = createRequire(import.meta.resolve("@react-navigation/native"));
  return import(nativeRequire.resolve("@react-navigation/core"));
});
vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      mocks.listeners.push(listener);
      return {
        remove: () => mocks.listeners.splice(mocks.listeners.indexOf(listener), 1),
      };
    },
  },
}));

import { useHardwareBack } from "./backHandler";

it("handles Back for content rendered outside a navigator", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onBack = vi.fn(() => true);
  function SignedOutScreen() {
    useHardwareBack(true, onBack);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

  act(() => root.render(<SignedOutScreen />));

  expect(mocks.listeners).toHaveLength(1);
  mocks.listeners[0]!();
  expect(onBack).toHaveBeenCalledOnce();
});
