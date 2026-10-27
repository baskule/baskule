import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ owner: new AbortController(), read: vi.fn() }));
vi.mock("./attachmentDownload", () => ({
  managedAttachmentOwner: () => ({ signal: native.owner.signal }),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    text = native.read;
  },
}));

import { useLocalHtmlDocument } from "./useLocalHtmlDocument";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.owner = new AbortController();
  native.read.mockReset().mockResolvedValue("<html>private document</html>");
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const states: ReturnType<typeof useLocalHtmlDocument>[] = [];
  function Document() {
    states.push(useLocalHtmlDocument("file:///cache/owned/page.html"));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    states,
    mount: () =>
      act(async () => {
        root.render(createElement(Document));
      }),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("erases an already rendered document when its file owner is revoked", async () => {
  using view = setup();
  await view.mount();
  expect(view.states.at(-1)?.document?.startsWith("data:text/html;charset=utf-8;base64,")).toBe(
    true,
  );
  await act(async () => native.owner.abort());
  expect(view.states.at(-1)).toEqual({ document: null, failed: true });
});

it("discards a file read that completes after account revocation", async () => {
  const reading = Promise.withResolvers<string>();
  native.read.mockReturnValue(reading.promise);
  using view = setup();
  await view.mount();
  await act(async () => {
    native.owner.abort();
    reading.resolve("<script>private bytes from the old account</script>");
  });
  expect(view.states.every((state) => state.document === null)).toBe(true);
  expect(view.states.at(-1)?.failed).toBe(true);
});
