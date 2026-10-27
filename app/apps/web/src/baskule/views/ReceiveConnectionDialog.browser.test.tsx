import { QrCode } from "@t3tools/shared/qrCode";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { connectLink } from "../connect";
import { ReceiveConnectionDialog, ReceiveConnectionPanel } from "./ReceiveConnectionDialog";

import "~/index.css";

function qrCanvas(value: string) {
  const qr = QrCode.encodeText(value, QrCode.Ecc.LOW);
  const canvas = document.createElement("canvas");
  const scale = 6;
  canvas.width = canvas.height = (qr.size + 8) * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
    }
  }
  return canvas;
}

async function qrFile(value: string) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    qrCanvas(value).toBlob((image) => (image ? resolve(image) : reject(new Error("No PNG"))));
  });
  return new File([blob], "connection.png", { type: "image/png" });
}

it("requires destination confirmation for paste and keeps paste usable after connection failure", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("Server unavailable"));
  await using screen = await render(<ReceiveConnectionPanel onConnect={connect} />);
  await userEvent.fill(screen.getByRole("textbox"), connectLink("https://baskule.example", "once"));
  await userEvent.click(screen.getByRole("button", { name: "Review connection" }));
  await expect.element(screen.getByText("https://baskule.example", { exact: true })).toBeVisible();
  expect(connect).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Server unavailable");
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    origin: "https://baskule.example",
    code: "once",
  });
  await userEvent.click(screen.getByRole("button", { name: "Use another connection" }));
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

it("imports a real QR image and waits for approval before consuming its code", async () => {
  const connect = vi.fn().mockResolvedValue(undefined);
  const file = await qrFile("baskule://connect?server=https%3A%2F%2Fbaskule.example&code=once");
  await using screen = await render(<ReceiveConnectionPanel onConnect={connect} />);
  await userEvent.upload(screen.getByLabelText("Import QR image"), file);
  await expect.element(screen.getByText("https://baskule.example", { exact: true })).toBeVisible();
  expect(connect).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    origin: "https://baskule.example",
    code: "once",
  });
  await expect.element(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
});

it("leaves paste available after an invalid image or an unsupported QR", async () => {
  const connect = vi.fn();
  await using screen = await render(<ReceiveConnectionPanel onConnect={connect} />);
  await userEvent.upload(
    screen.getByLabelText("Import QR image"),
    new File(["broken"], "bad.png", { type: "image/png" }),
  );
  await expect
    .element(
      screen.getByText(
        "Could not read a connection QR from this image. Try another image or paste a link.",
      ),
    )
    .toBeVisible();
  await userEvent.upload(
    screen.getByLabelText("Import QR image"),
    await qrFile("https://baskule.example/#token=bearer"),
  );
  await expect
    .element(
      screen.getByText(
        "Use a server address or a Baskule connection link without session credentials.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("textbox")).toBeVisible();
  expect(connect).not.toHaveBeenCalled();
});

it("ignores an image decode after the user reviews a pasted destination", async () => {
  const file = await qrFile("https://scanned.example");
  const image = await createImageBitmap(file);
  let finish: (image: ImageBitmap) => void = () => {
    throw new Error("Decode not started");
  };
  const pending = new Promise<ImageBitmap>((resolve) => {
    finish = resolve;
  });
  await using screen = await render(<ReceiveConnectionPanel onConnect={vi.fn()} />);
  using _bitmap = vi.spyOn(globalThis, "createImageBitmap").mockReturnValue(pending);
  using closed = vi.spyOn(image, "close");
  await userEvent.upload(screen.getByLabelText("Import QR image"), file);
  await userEvent.fill(screen.getByRole("textbox"), "https://pasted.example");
  await userEvent.click(screen.getByRole("button", { name: "Review connection" }));
  await act(() => finish(image));
  await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  await expect.element(screen.getByText("https://pasted.example", { exact: true })).toBeVisible();
  expect(screen.getByText("https://scanned.example", { exact: true }).query()).toBeNull();
});

it("falls back to paste when the camera is denied", async () => {
  await using screen = await render(<ReceiveConnectionPanel onConnect={vi.fn()} />);
  using _camera = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  await userEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await expect
    .element(
      screen.getByText(
        "Could not use the camera. Check camera permission, import an image, or paste a link.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

it("stops camera tracks when the receive dialog closes", async () => {
  const stream = document.createElement("canvas").captureStream(0);
  await using screen = await render(<ReceiveConnectionDialog />);
  using _camera = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
  await userEvent.click(screen.getByRole("button", { name: "Scan or import a connection" }));
  const dialog = page.getByRole("dialog", { name: "Connect this device" });
  await userEvent.click(dialog.getByRole("button", { name: "Use camera" }));
  await vi.waitFor(() => expect(_camera).toHaveBeenCalled());
  await userEvent.click(dialog.getByRole("button", { name: "Close", exact: true }));
  await vi.waitFor(() =>
    expect(stream.getTracks().every((track) => track.readyState === "ended")).toBe(true),
  );
});

it("stops a camera that becomes available after cancellation", async () => {
  const stream = qrCanvas("https://baskule.example").captureStream(0);
  let finish: (stream: MediaStream) => void = () => {
    throw new Error("Camera not requested");
  };
  const pending = new Promise<MediaStream>((resolve) => {
    finish = resolve;
  });
  await using screen = await render(<ReceiveConnectionPanel onConnect={vi.fn()} />);
  using _camera = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(pending);
  await userEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await userEvent.click(screen.getByRole("button", { name: "Stop camera" }));
  await act(() => finish(stream));
  expect(stream.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  await expect.element(screen.getByRole("textbox")).toBeVisible();
});

it("scans a camera QR once, releases the camera, and waits for confirmation", async () => {
  const canvas = qrCanvas(connectLink("https://camera.example", "camera-code"));
  const stream = canvas.captureStream(0);
  const connect = vi.fn();
  await using screen = await render(<ReceiveConnectionPanel onConnect={connect} />);
  using _camera = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
  await userEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await expect.element(screen.getByText("https://camera.example", { exact: true })).toBeVisible();
  expect(stream.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  expect(connect).not.toHaveBeenCalled();
});
