export async function decodeQrPixels(
  pixels: Pick<ImageData, "data" | "width" | "height">,
): Promise<string | null> {
  const { default: jsQR } = await import("jsqr");
  return jsQR(pixels.data, pixels.width, pixels.height)?.data ?? null;
}

export async function decodeQrImage(file: File): Promise<string | null> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image reading is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height));
  } finally {
    image.close();
  }
}

export async function startQrCamera({
  video,
  signal,
  onResult,
  onError,
}: {
  video: HTMLVideoElement;
  signal: AbortSignal;
  onResult: (value: string) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  let stream: MediaStream | null = null;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable.");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 960 } },
      audio: false,
    });
    if (signal.aborted) {
      stop();
      return;
    }
    video.srcObject = stream;
    await video.play();
    if (signal.aborted) {
      stop();
      return;
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Camera reading is unavailable.");
    let lastFrame = 0;
    const scan = async (now: number) => {
      if (signal.aborted) return;
      if (now - lastFrame >= 150 && video.readyState >= 2 && video.videoWidth > 0) {
        lastFrame = now;
        const scale = Math.min(1, 960 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const result = await decodeQrPixels(
            context.getImageData(0, 0, canvas.width, canvas.height),
          );
          if (signal.aborted) return;
          if (result) {
            stop();
            onResult(result);
            return;
          }
        } catch (error) {
          stop();
          if (!signal.aborted) onError(error);
          return;
        }
      }
      frame = requestAnimationFrame((time) => void scan(time));
    };
    frame = requestAnimationFrame((time) => void scan(time));
  } catch (error) {
    stop();
    if (!signal.aborted) onError(error);
  }
}
