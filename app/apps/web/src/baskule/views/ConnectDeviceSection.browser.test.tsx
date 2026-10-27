import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { baskuleApi, type BaskuleMe } from "../api";
import { decodeQrPixels } from "../qrReceive";
import { __setBaskuleMeForTests, readBaskuleMe } from "../session";
import { ConnectDeviceSection } from "./ConnectDeviceSection";

import "~/index.css";

function session(mode: "anonymous" | "authenticated"): Disposable {
  const previous = readBaskuleMe();
  __setBaskuleMeForTests({
    authentication: { mode, password: mode === "authenticated", providers: [] },
    user: { id: "person", name: "Person", email: "person@example.com", role: "member" },
    organizationName: null,
    spaces: [],
    canCreateSpaces: false,
    voiceInput: false,
  } satisfies BaskuleMe);
  return { [Symbol.dispose]: () => __setBaskuleMeForTests(previous) };
}

async function decodeSvg(svg: Element) {
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0);
    return await decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height));
  } finally {
    URL.revokeObjectURL(url);
  }
}

it("shows an anonymous server QR and copy field using the installation HTTP origin", async () => {
  using _session = session("anonymous");
  using _bridge = stubGlobal("desktopBridge", {
    getBaskuleServer: () => "https://installation.example",
  });
  await using screen = await render(<ConnectDeviceSection />);
  const qr = screen.getByRole("img", { name: "Server address for another device" });
  expect(await decodeSvg(qr.element())).toBe("https://installation.example");
  await expect
    .element(screen.getByRole("textbox", { name: "Server address" }))
    .toHaveValue("https://installation.example");
  await expect
    .element(screen.getByRole("button", { name: "Scan or import a connection" }))
    .toBeVisible();
});

it("generates distinct one-time QR links, keeps paste available, and retires the expired QR", async () => {
  using _session = session("authenticated");
  using _bridge = stubGlobal("desktopBridge", {
    getBaskuleServer: () => "https://installation.example",
  });
  await using screen = await render(<ConnectDeviceSection />);
  using _clock = fakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const expiresAt = Date.now() + 600_000;
  using create = vi
    .spyOn(baskuleApi, "createConnectCode")
    .mockResolvedValueOnce({ code: "first", expiresAt })
    .mockResolvedValueOnce({ code: "second", expiresAt });
  await act(() =>
    screen
      .getByRole("button", { name: "Show QR for another device" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  const qr = () => screen.getByRole("img", { name: "Sign-in link for another device" });
  expect(await decodeSvg(qr().element())).toBe("https://installation.example/link#code=first");
  await act(() =>
    screen
      .getByRole("button", { name: "New connection link" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(await decodeSvg(qr().element())).toBe("https://installation.example/link#code=second");
  await expect
    .element(screen.getByRole("textbox", { name: "Connection link" }))
    .toHaveValue("https://installation.example/link#code=second");
  expect(create).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(600_000));
  await expect
    .element(
      screen.getByText("This connection link expired. Create a new one to sign in another device."),
    )
    .toBeVisible();
  expect(qr().query()).toBeNull();
  await expect.element(screen.getByRole("button", { name: "New connection link" })).toBeVisible();
});
