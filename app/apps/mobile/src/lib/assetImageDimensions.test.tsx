import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import useImageDimensions from "react-native-image-viewing/dist/hooks/useImageDimensions";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ getSizeWithHeaders: vi.fn() }));
vi.mock("react-native", () => ({
  Animated: {},
  PanResponder: {},
  Image: { getSizeWithHeaders: native.getSizeWithHeaders },
}));

import { nativeAssetImageSource } from "./assetImageSource";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.getSizeWithHeaders
    .mockReset()
    .mockImplementation((_uri, _headers, loaded) => loaded(640, 480));
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["file:///cache/owned/dimensions.jpg", { "Cache-Control": "no-store" }],
  ["https://external.test/dimensions.jpg", undefined],
])("measures %s through the viewer's native dimension request", async (uri, headers) => {
  const source = nativeAssetImageSource(uri);
  function Viewer() {
    const dimensions = useImageDimensions(source);
    return createElement("p", null, dimensions && `${dimensions.width} × ${dimensions.height}`);
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Viewer)));
    expect(container.textContent).toBe("640 × 480");
    expect(native.getSizeWithHeaders).toHaveBeenCalledExactlyOnceWith(
      uri,
      headers,
      expect.any(Function),
      expect.any(Function),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
