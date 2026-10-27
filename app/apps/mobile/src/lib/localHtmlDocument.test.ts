import { beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ read: vi.fn(), opened: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(uri: string) {
      native.opened(uri);
    }
    text = native.read;
  },
}));

import { localHtmlDocument } from "./localHtmlDocument";

beforeEach(() => vi.clearAllMocks());

it("encodes complete local UTF-8 HTML in memory without handing file access to the page", async () => {
  const content = "<html><body>é🙂<script>window.rendered = true;</script></body></html>";
  native.read.mockResolvedValue(content);
  const source = await localHtmlDocument(
    "file:///cache/owned/page.html#theme",
    new AbortController().signal,
  );
  expect(source.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true);
  const decoded = Buffer.from(source.split(",")[1]!, "base64").toString("utf8");
  expect(decoded.endsWith(content)).toBe(true);
  expect(decoded.indexOf("Content-Security-Policy")).toBeLessThan(decoded.indexOf("<script>"));
  expect(decoded).toContain("default-src 'none'");
  expect(decoded).toContain("connect-src 'none'");
  expect(decoded).toContain("frame-src 'none'");
  expect(decoded).toContain("base-uri 'none'");
  expect(decoded).toContain("form-action 'none'");
  expect(native.opened).toHaveBeenCalledWith("file:///cache/owned/page.html");
});

it.each(["https://host.test/s/space/page.html", "content://unowned/page.html"])(
  "refuses remote acquisition through the document renderer for %s",
  async (uri) => {
    await expect(localHtmlDocument(uri, new AbortController().signal)).rejects.toThrow(
      "local document",
    );
    expect(native.opened).not.toHaveBeenCalled();
  },
);

it("does not publish bytes after the document owner cancels an active file read", async () => {
  const read = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  native.read.mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  const controller = new AbortController();
  const load = localHtmlDocument("file:///cache/owned/page.html", controller.signal);
  await started.promise;
  controller.abort();
  read.resolve("<script>late()</script>");
  await expect(load).rejects.toThrow();
});

it("does not read a canceled document", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    localHtmlDocument("file:///cache/owned/page.html", controller.signal),
  ).rejects.toThrow();
  expect(native.opened).not.toHaveBeenCalled();
});
