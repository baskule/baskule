import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ createPlayer: vi.fn() }));
vi.mock("expo-video", () => ({ createVideoPlayer: mocks.createPlayer }));

let thumbnails: typeof import("./videoThumbnails");
const frame = { width: 480, height: 270 };
const player = () => ({
  replaceAsync: vi.fn(async (): Promise<void> => {}),
  generateThumbnailsAsync: vi.fn(async () => [frame]),
  release: vi.fn(),
});
const source = () => ({ uri: "file:///clip.mp4", dispose: vi.fn() });

beforeEach(async () => {
  vi.resetModules();
  mocks.createPlayer.mockReset().mockImplementation(player);
  thumbnails = await import("./videoThumbnails");
});

afterEach(() => vi.useRealTimers());

describe("video thumbnails", () => {
  it("serializes decoding and skips queued requests that scroll out of view", async () => {
    const started = Promise.withResolvers<void>();
    const generated = Promise.withResolvers<(typeof frame)[]>();
    const first = player();
    first.generateThumbnailsAsync.mockImplementation(() => {
      started.resolve();
      return generated.promise;
    });
    mocks.createPlayer.mockReturnValueOnce(first);
    const firstRequest = thumbnails.loadVideoThumbnail(
      "first",
      async () => source(),
      new AbortController().signal,
    );
    await started.promise;
    const removed = new AbortController();
    const skipped = vi.fn(async () => source());
    const queued = thumbnails.loadVideoThumbnail("removed", skipped, removed.signal);
    const next = vi.fn(async () => source());
    const nextRequest = thumbnails.loadVideoThumbnail("next", next, new AbortController().signal);
    expect(next).not.toHaveBeenCalled();
    removed.abort();
    generated.resolve([frame]);
    expect(await firstRequest).toBe(frame);
    expect(await queued).toBeNull();
    expect(await nextRequest).toBe(frame);
    expect(skipped).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledTimes(1);
  });

  it("releases an active canceled player and ignores late source loading", async () => {
    const started = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    const first = player();
    first.replaceAsync.mockImplementation(() => {
      started.resolve();
      return replaced.promise;
    });
    mocks.createPlayer.mockReturnValueOnce(first);
    const file = source();
    const controller = new AbortController();
    const request = thumbnails.loadVideoThumbnail("canceled", async () => file, controller.signal);
    await started.promise;
    controller.abort();
    expect(await request).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    replaced.resolve();
    expect(
      await thumbnails.loadVideoThumbnail(
        "next",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
    expect(first.generateThumbnailsAsync).not.toHaveBeenCalled();
    expect(thumbnails.cachedVideoThumbnail("canceled")).toBeNull();
  });
});

it("does not retain a frame from an account-owned file in the shared thumbnail cache", async () => {
  const resolveSource = vi.fn(async () => source());
  const signal = new AbortController().signal;
  expect(await thumbnails.loadVideoThumbnail(null, resolveSource, signal)).toBe(frame);
  expect(await thumbnails.loadVideoThumbnail(null, resolveSource, signal)).toBe(frame);
  expect(mocks.createPlayer).toHaveBeenCalledTimes(2);
  expect(resolveSource).toHaveBeenCalledTimes(2);
});

it("releases a managed frame that finishes decoding after cancellation", async () => {
  const started = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<Array<typeof frame & { release: () => void }>>();
  const first = player();
  first.generateThumbnailsAsync.mockImplementationOnce(() => {
    started.resolve();
    return decoded.promise;
  });
  mocks.createPlayer.mockReturnValueOnce(first);
  const controller = new AbortController();
  const request = thumbnails.loadVideoThumbnail(null, async () => source(), controller.signal);
  await started.promise;
  controller.abort();
  await expect(request).resolves.toBeNull();
  const release = vi.fn();
  decoded.resolve([{ ...frame, release }]);
  await decoded.promise;
  expect(release).toHaveBeenCalledOnce();
});
