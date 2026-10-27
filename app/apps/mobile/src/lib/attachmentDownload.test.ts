import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

const mocks = vi.hoisted(() => ({
  directories: new Set<string>(),
  listeners: new Set<() => void>(),
  connection: null as PreparedConnection | null,
  permitted: true,
  deleted: vi.fn(),
  evict: vi.fn(),
  download: vi.fn(),
  copy: vi.fn(),
  write: vi.fn(),
  share: vi.fn(),
  shareFromSource: vi.fn(),
  available: vi.fn(),
  open: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock("../baskule/session", () => ({
  readBaskuleSession: () => ({ status: "loading" }),
  subscribeBaskuleSession: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock("../state/session", () => ({
  readPreparedConnection: () => mocks.connection,
  readEnvironmentScope: () => mocks.permitted,
  environmentSession: {
    preparedConnectionValueAtom: () => "connection",
    sessionStateAtom: () => "scope",
  },
}));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock("./nativeTransfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nativeTransfer")>()),
  fetchNativeFile: async (input: { url: string; signal: AbortSignal }) => ({
    ok: true,
    status: 200,
    body: {
      pipeTo: (file: { uri: string }, options: { signal: AbortSignal }) =>
        mocks.download(input.url, file, options),
    },
  }),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }

    get name(): string {
      return this.uri.split("/").at(-1)!;
    }

    get exists(): boolean {
      return mocks.directories.has(this.uri);
    }

    create(): void {
      mocks.directories.add(this.uri);
    }

    list(): Directory[] {
      const prefix = `${this.uri}/`;
      return [...mocks.directories]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new Directory(uri));
    }

    delete(): void {
      mocks.deleted(this.uri);
      mocks.directories.delete(this.uri);
    }
  }

  class File {
    static downloadFileAsync = mocks.download;
    readonly uri: string;

    constructor(source: Directory | string, name?: string) {
      this.uri = typeof source === "string" ? source : `${source.uri}/${encodeURIComponent(name!)}`;
    }

    create() {}
    write = mocks.write;
    writableStream() {
      return this;
    }

    async copy(destination: File): Promise<void> {
      await mocks.copy(this.uri, destination.uri);
    }
  }

  return { Directory, File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo", () => ({
  requireNativeModule: () => ({ openFile: mocks.open, evictImage: mocks.evict }),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));

vi.mock("./uuid", () => ({ uuidv4: mocks.uuid }));
vi.mock("./shareFileFromSource", () => ({ shareFileFromSource: mocks.shareFromSource }));

import {
  openAttachmentInViewer,
  downloadAndShareAttachment,
  downloadAttachmentForPreview,
  shareLocalAttachment,
  shareGeneratedAttachment,
} from "./attachmentDownload";
import { isForegroundHandoffActive } from "./foreground-handoff";

const NOW = 1_787_990_400_000;
const DAY_MS = 24 * 60 * 60_000;
const CACHE = "file:///cache/t3-attachment-downloads";
const input = {
  url: "https://chosen-environment.example/api/assets/signed-token/report.pdf",
  attachment: { name: "report.pdf", mimeType: "application/pdf" },
};

beforeEach(() => {
  mocks.write.mockReset();
  mocks.evict.mockReset();
  mocks.listeners.clear();
  mocks.permitted = true;
  mocks.connection = null;
  mocks.open.mockReset();
  mocks.open.mockResolvedValue(undefined);
  mocks.directories.clear();
  mocks.deleted.mockReset();
  mocks.download.mockReset();
  mocks.copy.mockReset();
  mocks.share.mockReset();
  mocks.shareFromSource.mockReset();
  mocks.available.mockReset();
  mocks.uuid.mockReset();
  mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => file);
  mocks.copy.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue(undefined);
  mocks.shareFromSource.mockResolvedValue(undefined);
  mocks.available.mockResolvedValue(true);
  let sequence = 0;
  mocks.uuid.mockImplementation(
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(isForegroundHandoffActive()).toBe(false);
});

describe("downloadAndShareAttachment", () => {
  it("downloads the chosen environment's signed URL and shares the local file", async () => {
    const controller = new AbortController();
    await downloadAndShareAttachment({ transfer: null, ...input, signal: controller.signal });

    expect(mocks.download).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({ uri: expect.stringMatching(/\/report\.pdf$/) }),
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.share).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
      {
        mimeType: "application/pdf",
        dialogTitle: "report.pdf",
      },
    );
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("shares videos even when the server serves their bytes inline", async () => {
    await downloadAndShareAttachment({
      transfer: null,
      url: "https://relay-environment.example/api/assets/signed-video/clip.mp4",
      attachment: { name: "clip.mp4", mimeType: 'video/mp4; codecs="avc1"' },
      signal: new AbortController().signal,
    });

    expect(mocks.share).toHaveBeenCalledWith(expect.stringMatching(/\/clip\.mp4$/), {
      mimeType: "video/mp4",
      dialogTitle: "clip.mp4",
    });
  });

  it.each([
    ["../../résumé.pdf", "résumé.pdf"],
    ["C:\\folder\\clip.mp4", "clip.mp4"],
    ["a?query#part%2F.txt", "a?query#part%2F.txt"],
    ["Report #5 - 100%.pdf", "Report #5 - 100%.pdf"],
    ["..", "attachment"],
    ["  ", "attachment"],
    ["\ud800file\u0000.txt", "_file_.txt"],
    [".env", ".env"],
  ])("uses a safe basename for %j", async (name, expected) => {
    await downloadAndShareAttachment({
      transfer: null,
      ...input,
      attachment: { ...input.attachment, name },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    expect(decodeURIComponent(file.uri.split("/").at(-1)!)).toBe(expected);
  });

  it("preserves ordinary long filenames that fit within the filesystem limit", async () => {
    const name =
      "Project quarterly report with detailed implementation and delivery notes for August 2026.pdf";
    await downloadAndShareAttachment({
      transfer: null,
      ...input,
      attachment: { ...input.attachment, name },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    expect(decodeURIComponent(file.uri.split("/").at(-1)!)).toBe(name);
  });

  it("bounds the UTF-8 filename length while preserving its extension", async () => {
    await downloadAndShareAttachment({
      transfer: null,
      ...input,
      attachment: { name: `${"🙂".repeat(80)}.mp4`, mimeType: "video/mp4" },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    const name = decodeURIComponent(file.uri.split("/").at(-1)!);
    expect(name.endsWith(".mp4")).toBe(true);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });

  it("reports unavailable sharing before downloading or creating files", async () => {
    mocks.available.mockResolvedValue(false);
    await expect(
      downloadAndShareAttachment({
        transfer: null,
        ...input,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Saving and sharing files is unavailable on this device.");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.directories.size).toBe(0);
  });

  it("cleans an interrupted download only after the native request settles", async () => {
    const started = Promise.withResolvers<void>();
    const download = Promise.withResolvers<{ uri: string }>();
    mocks.download.mockImplementation(() => {
      started.resolve();
      return download.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    download.reject(new Error("Canceled native request"));
    await task;
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("does not open a late download after cancellation", async () => {
    const started = Promise.withResolvers<{ uri: string }>();
    const download = Promise.withResolvers<{ uri: string }>();
    mocks.download.mockImplementation((_url: string, file: { uri: string }) => {
      started.resolve(file);
      return download.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: controller.signal,
    });
    const file = await started.promise;
    controller.abort();
    download.resolve(file);
    await task;
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("retains an export when its row unmounts during the native handoff", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementation(() => {
      expect(isForegroundHandoffActive()).toBe(true);
      opened.resolve();
      return share.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: controller.signal,
    });
    await opened.promise;
    controller.abort();
    share.resolve();
    await task;
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("cleans failed exports and releases the foreground handoff", async () => {
    mocks.share.mockRejectedValue(new Error("No activity can open this file"));
    await expect(
      downloadAndShareAttachment({
        transfer: null,
        ...input,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Could not open the share sheet. Try again.");
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("removes expired exports while leaving recent and unrelated cache entries alone", async () => {
    const old = `${CACHE}/${NOW - DAY_MS - 1}-00000000-0000-4000-8000-000000000010`;
    const recent = `${CACHE}/${NOW - DAY_MS + 1}-00000000-0000-4000-8000-000000000011`;
    const unrelated = `${CACHE}/unrelated`;
    mocks.directories.add(old).add(recent).add(unrelated);

    await downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: new AbortController().signal,
    });
    expect(mocks.deleted.mock.calls).toEqual([[old]]);
    expect(mocks.directories.has(recent)).toBe(true);
    expect(mocks.directories.has(unrelated)).toBe(true);
  });

  it("does not prune an active export even if it passes the cache expiry", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementationOnce(() => {
      opened.resolve();
      return share.promise;
    });
    const first = downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: new AbortController().signal,
    });
    await opened.promise;
    vi.mocked(Date.now).mockReturnValue(NOW + DAY_MS + 1);

    await downloadAndShareAttachment({
      transfer: null,
      ...input,
      signal: new AbortController().signal,
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
    share.resolve();
    await first;
  });
});

describe("attachment preview files", () => {
  it("does not start a native request after cancellation during setup", async () => {
    const controller = new AbortController();
    const loading = downloadAttachmentForPreview({
      transfer: null,
      ...input,
      signal: controller.signal,
    });
    controller.abort();
    await expect(loading).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("downloads for playback without requiring a share sheet and removes the file on close", async () => {
    mocks.available.mockResolvedValue(false);
    const file = await downloadAttachmentForPreview({
      transfer: null,
      ...input,
      signal: new AbortController().signal,
    });
    expect(file?.uri.endsWith("/report.pdf")).toBe(true);
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
    file?.dispose();
    file?.dispose();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "share-button"])(
    "keeps a shared preview after its owner closes (source: %s)",
    async (sourceIdentifier) => {
      const opened = Promise.withResolvers<void>();
      const sharing = Promise.withResolvers<void>();
      const nativeShare = sourceIdentifier ? mocks.shareFromSource : mocks.share;
      nativeShare.mockImplementationOnce(() => {
        opened.resolve();
        return sharing.promise;
      });
      const file = await downloadAttachmentForPreview({
        transfer: null,
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await opened.promise;
      file!.dispose();
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(true);
      sharing.resolve();
      await share;
      expect(isForegroundHandoffActive()).toBe(false);
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.copy).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "share-button"])(
    "does not share a disposed preview after availability checking (source: %s)",
    async (sourceIdentifier) => {
      const checking = Promise.withResolvers<void>();
      const available = Promise.withResolvers<boolean>();
      mocks.available.mockImplementation(() => {
        checking.resolve();
        return available.promise;
      });
      const file = await downloadAttachmentForPreview({
        transfer: null,
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await checking.promise;
      file!.dispose();
      available.resolve(true);
      await share;
      expect(mocks.share).not.toHaveBeenCalled();
      expect(mocks.shareFromSource).not.toHaveBeenCalled();
      expect(mocks.deleted).toHaveBeenCalledTimes(1);
    },
  );

  it("copies a local original before sharing without downloading or deleting the source", async () => {
    const uri = "file:///documents/draft/report.pdf";
    await shareLocalAttachment({
      uri,
      attachment: input.attachment,
      signal: new AbortController().signal,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      uri,
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
    );
    expect(mocks.share).toHaveBeenCalledWith(mocks.copy.mock.calls[0]![1], expect.any(Object));
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("waits for a local copy to finish before cleaning up a canceled share", async () => {
    const copying = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<void>();
    mocks.copy.mockImplementation(() => {
      copying.resolve();
      return copied.promise;
    });
    const controller = new AbortController();
    const task = shareLocalAttachment({
      uri: "file:///documents/draft/report.pdf",
      attachment: input.attachment,
      signal: controller.signal,
    });
    await copying.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    copied.resolve();
    await task;
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });
});

describe("document viewer handoff", () => {
  it("opens a cache copy with its MIME type and retains it for the viewer", async () => {
    await openAttachmentInViewer({
      transfer: null,
      uri: "file:///documents/report.pdf",
      attachment: input.attachment,
      signal: new AbortController().signal,
    });
    expect(mocks.open).toHaveBeenCalledWith(mocks.copy.mock.calls[0]![1], "application/pdf");
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
  it("cleans up when no viewer handles the document", async () => {
    mocks.open.mockRejectedValue(new Error("No viewer"));
    await expect(
      openAttachmentInViewer({
        transfer: null,
        uri: input.url,
        attachment: input.attachment,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("No viewer");
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(isForegroundHandoffActive()).toBe(false);
  });
});

function protectedTransfer() {
  const environmentId = EnvironmentId.make("file-owner");
  const connection: PreparedConnection = {
    environmentId,
    label: "owner",
    httpBaseUrl: "https://host.test",
    socketUrl: "wss://host.test/ws",
    httpAuthorization: null,
    target: {
      _tag: "BearerConnectionTarget",
      connectionId: "owner",
      environmentId,
      label: "owner",
    },
  };
  mocks.connection = connection;
  return { environmentId, origin: { connection, serverUrl: null, token: null } };
}

it.each(["account", "scope"])(
  "revokes every app-owned sharing copy after chooser return on %s change",
  async (change) => {
    const transfer = protectedTransfer();
    const owner = new AbortController();
    const original = await downloadAttachmentForPreview({
      ...input,
      transfer,
      signal: owner.signal,
    });
    const share = new AbortController();
    await shareLocalAttachment({
      uri: original!.uri,
      attachment: input.attachment,
      signal: share.signal,
    });
    const handedOff = mocks.copy.mock.calls[0]![1] as string;
    const evicted = Promise.withResolvers<void>();
    mocks.evict.mockImplementation((uri: string) => {
      if (uri === handedOff) evicted.resolve();
    });
    owner.abort();
    original!.dispose();
    share.abort();
    expect(mocks.directories.has(handedOff.slice(0, handedOff.lastIndexOf("/")))).toBe(true);
    if (change === "scope") mocks.permitted = false;
    else mocks.connection = null;
    for (const listener of mocks.listeners) listener();
    expect([...mocks.directories].filter((uri) => uri !== CACHE)).toEqual([]);
    expect(mocks.listeners.size).toBe(0);
    await evicted.promise;
    expect(mocks.evict).toHaveBeenCalledWith(handedOff);
  },
);

it("keeps a native viewer copy revocable after its preview closes", async () => {
  const transfer = protectedTransfer();
  const original = await downloadAttachmentForPreview({
    ...input,
    transfer,
    signal: new AbortController().signal,
  });
  const controller = new AbortController();
  await openAttachmentInViewer({
    uri: original!.uri,
    attachment: input.attachment,
    signal: controller.signal,
    transfer: null,
  });
  original!.dispose();
  controller.abort();
  expect(mocks.deleted).toHaveBeenCalledTimes(1);
  mocks.connection = null;
  for (const listener of mocks.listeners) listener();
  expect([...mocks.directories].filter((uri) => uri !== CACHE)).toEqual([]);
  expect(mocks.listeners.size).toBe(0);
});

it("removes a late native copy after the account changes during the copy", async () => {
  const transfer = protectedTransfer();
  const original = await downloadAttachmentForPreview({
    ...input,
    transfer,
    signal: new AbortController().signal,
  });
  const started = Promise.withResolvers<void>();
  const copied = Promise.withResolvers<void>();
  mocks.copy.mockImplementationOnce(() => {
    started.resolve();
    return copied.promise;
  });
  const share = shareLocalAttachment({
    uri: original!.uri,
    attachment: input.attachment,
    signal: new AbortController().signal,
  });
  await started.promise;
  mocks.connection = null;
  for (const listener of mocks.listeners) listener();
  copied.resolve();
  await share;
  expect(mocks.share).not.toHaveBeenCalled();
  expect([...mocks.directories].filter((uri) => uri !== CACHE)).toEqual([]);
  expect(mocks.listeners.size).toBe(0);
});

it("revokes an active share without retaining a copy when its chooser eventually returns", async () => {
  const transfer = protectedTransfer();
  const started = Promise.withResolvers<void>();
  const chooser = Promise.withResolvers<void>();
  mocks.share.mockImplementationOnce(() => {
    started.resolve();
    return chooser.promise;
  });
  const share = downloadAndShareAttachment({
    ...input,
    transfer,
    signal: new AbortController().signal,
  });
  await started.promise;
  mocks.permitted = false;
  for (const listener of mocks.listeners) listener();
  expect([...mocks.directories].filter((uri) => uri !== CACHE)).toEqual([]);
  chooser.resolve();
  await share;
  expect(mocks.listeners.size).toBe(0);
  expect(isForegroundHandoffActive()).toBe(false);
});

it("keeps generated app exports revocable without changing their bytes", async () => {
  const transfer = protectedTransfer();
  const bytes = Uint8Array.of(0, 255, 192, 128, 1);
  const controller = new AbortController();
  await expect(
    shareGeneratedAttachment({
      bytes,
      attachment: input.attachment,
      transfer,
      signal: controller.signal,
    }),
  ).resolves.toBe(true);
  expect(mocks.write).toHaveBeenCalledWith(bytes);
  controller.abort();
  expect(mocks.deleted).not.toHaveBeenCalled();
  mocks.connection = null;
  for (const listener of mocks.listeners) listener();
  expect([...mocks.directories].filter((uri) => uri !== CACHE)).toEqual([]);
  expect(mocks.listeners.size).toBe(0);
});
