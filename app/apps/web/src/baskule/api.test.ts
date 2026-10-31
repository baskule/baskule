// baskule: wire → view-model mapping of the Baskule front API (platform/README.md).
import { describe, expect, it, vi } from "vite-plus/test";

import {
  computerStateFrom,
  describeDownload,
  meFromWire,
  messageFromBody,
  baskuleApi,
  personFromWire,
  spaceBaseUrl,
  statusFromWire,
} from "./api";

describe("Baskule API mapping", () => {
  it("maps /me with the personal space first and the space base path", () => {
    const me = meFromWire({
      authentication: { mode: "authenticated", password: true, providers: [] },
      user: { id: "u1", name: "Alice", email: "a@x.test", role: "member", canCreateSpaces: true },
      organization: { name: "Acme Corp" },
      spaces: [
        { id: "p1", name: "Personal", kind: "personal", role: "owner", base: "/s/p1" },
        { id: "t1", name: "Acme", kind: "team", role: "member" },
      ],
    });
    expect(me.canCreateSpaces).toBe(true);
    expect(me.voiceInput).toBe(false);
    expect(me.organizationName).toBe("Acme Corp");
    expect(me.spaces.map((space) => space.base)).toEqual(["/s/p1", "/s/t1"]);
  });

  it("derives a person's status from ban and first sign-in", () => {
    const base = {
      id: "u",
      name: "B",
      email: "b@x.test",
      role: "member",
      activeSessions: 2,
    };
    expect(personFromWire({ ...base, banned: true, firstSignInAt: 1 }).status).toBe("deactivated");
    expect(personFromWire({ ...base, banned: false, firstSignInAt: null }).status).toBe("invited");
    expect(personFromWire({ ...base, banned: false, firstSignInAt: 1 }).status).toBe("active");
  });

  it("reads the computer state whatever shape computerd reports", () => {
    expect(computerStateFrom("running")).toBe("running");
    expect(computerStateFrom({ state: "Ready" })).toBe("running");
    expect(computerStateFrom({ status: "stopped" })).toBe("stopped");
    for (const [phase, expected] of Object.entries({
      absent: "stopped",
      starting: "starting",
      ready: "running",
      stopping: "stopping",
      stopped: "stopped",
      error: "error",
    })) {
      expect(
        statusFromWire({
          awake: true,
          sockets: 1,
          activeRuns: 0,
          computer: { spaceId: "space-a", phase },
        })?.computer,
      ).toBe(expected);
    }
    expect(computerStateFrom({ error: "computerd 503" })).toBe("error");
    expect(computerStateFrom(null)).toBe("stopped");
    expect(computerStateFrom(undefined)).toBe("unknown");
    expect(computerStateFrom("weird")).toBe("unknown");
  });

  it("keeps a failed status check visible", () => {
    expect(statusFromWire(null)).toBeNull();
    expect(statusFromWire({ error: "timeout" })).toEqual({
      awake: false,
      sockets: 0,
      activeRuns: 0,
      computer: "unknown",
      error: "timeout",
    });
    expect(
      statusFromWire({ awake: true, sockets: 3, activeRuns: 1, computer: "running" }),
    ).toMatchObject({
      awake: true,
      sockets: 3,
      activeRuns: 1,
      computer: "running",
      error: null,
    });
  });

  it("describes published app files", () => {
    expect(
      describeDownload({ name: "Baskule-0.2.0-x86_64.AppImage", size: 10, url: "/downloads/a" }),
    ).toMatchObject({
      platform: "linux",
      format: "AppImage",
      version: "0.2.0",
      sizeBytes: 10,
    });
    expect(describeDownload({ name: "baskule-0.2.0-linux-x64.tar.gz", url: "/d" })).toMatchObject({
      platform: "linux",
      format: "tar.gz",
    });
    expect(describeDownload({ name: "Baskule-0.2.0.apk", url: "/d" }).platform).toBe("android");
  });

  it("turns error codes into sentences", () => {
    expect(
      messageFromBody(
        { error: "last_owner", message: "a team space keeps at least one owner" },
        409,
      ).message,
    ).toBe("A team space keeps at least one owner.");
    expect(messageFromBody({ error: "something_new", message: "details here" }, 400)).toEqual({
      message: "Details here",
      code: "something_new",
    });
    expect(
      messageFromBody(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        401,
      ).code,
    ).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(messageFromBody(null, 403).message).toBe("You don't have permission to do that.");
  });

  it("uploads a recording as its raw body and reads the transcript", async () => {
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ text: "Hello there" }))
      .mockResolvedValueOnce(Response.json({ error: "audio_too_large" }, { status: 413 }));
    const recording = new Blob(["voice"], { type: "audio/webm;codecs=opus" });
    await expect(baskuleApi.transcribe(recording)).resolves.toBe("Hello there");
    const [path, init] = fetchSpy.mock.calls[0]!;
    expect(path).toBe("/api/baskule/transcriptions");
    expect(init).toMatchObject({
      method: "POST",
      body: recording,
      headers: { "content-type": "audio/webm;codecs=opus" },
    });
    await expect(baskuleApi.transcribe(recording)).rejects.toMatchObject({
      status: 413,
      code: "audio_too_large",
      message: "The recording is too long to transcribe.",
    });
  });

  it("explains voice input refusals, with the provider's reason when the server gives one", () => {
    const message = (body: unknown, status: number) => messageFromBody(body, status).message;
    expect(message({ error: "shared_api_key", message: "shared_api_key" }, 400)).toBe(
      "This key is shared with chat. Change it on AI → Models.",
    );
    expect(message({ code: "usage_limit_reached", message: "Your daily limit…" }, 400)).toBe(
      "Usage limit reached",
    );
    expect(message({ error: "too_many_requests", message: "too_many_requests" }, 429)).toBe(
      "Too many attempts. Wait a minute and try again.",
    );
    expect(message({ error: "invalid_audio", message: "invalid_audio" }, 400)).toBe(
      "The recording could not be read. Try again.",
    );
    expect(
      message(
        { error: "transcription_key_rejected", message: "The provider rejected the API key" },
        502,
      ),
    ).toBe(
      "The transcription provider rejected the API key. Ask an admin to check AI → Voice input.",
    );
    expect(
      message(
        { error: "transcription_failed", message: "Transcription provider answered 500" },
        502,
      ),
    ).toBe("The recording could not be transcribed. Try again.");
    expect(message({ error: "transcription_failed", message: "transcription_failed" }, 502)).toBe(
      "The recording could not be transcribed. Try again.",
    );
  });

  it("builds a space's environment URL from its base path", () => {
    expect(spaceBaseUrl("http://100.64.0.42:47090", "/s/abc")).toBe(
      "http://100.64.0.42:47090/s/abc/",
    );
    expect(spaceBaseUrl("http://host/", "/s/abc/")).toBe("http://host/s/abc/");
  });
});
