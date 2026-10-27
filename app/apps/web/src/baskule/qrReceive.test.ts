import { expect, it } from "vite-plus/test";
import { QrCode } from "@t3tools/shared/qrCode";

import { connectLink } from "./connect";
import { decodeQrPixels } from "./qrReceive";

it.each(["https://baskule.example", connectLink("https://baskule.example", "one-time-code")])(
  "decodes the generated QR pixels to %s without BarcodeDetector",
  async (value) => {
    const qr = QrCode.encodeText(value, QrCode.Ecc.LOW);
    const scale = 5;
    const margin = 4;
    const width = (qr.size + margin * 2) * scale;
    const data = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (qr.getModule(Math.floor(x / scale) - margin, Math.floor(y / scale) - margin)) {
          const index = (y * width + x) * 4;
          data[index] = 0;
          data[index + 1] = 0;
          data[index + 2] = 0;
        }
      }
    }
    expect(await decodeQrPixels({ data, width, height: width })).toBe(value);
  },
);

it("returns no QR for a blank image", async () => {
  expect(
    await decodeQrPixels({
      data: new Uint8ClampedArray(80 * 80 * 4).fill(255),
      width: 80,
      height: 80,
    }),
  ).toBeNull();
});
