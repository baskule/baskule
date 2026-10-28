import { useEffect, useRef, useState } from "react";
import { CameraIcon, QrCodeIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { useTranslation } from "../../i18n";
import { connectionTargetLink, parseConnectionTarget, type ConnectionTarget } from "../connect";
import { decodeQrImage, startQrCamera } from "../qrReceive";
import { clearLocalAppData } from "../session";
import { FormField } from "../ui";

export async function openConnectionTarget(target: ConnectionTarget): Promise<void> {
  const link = connectionTargetLink(target);
  if (window.desktopBridge?.connectBaskuleServer) {
    await window.desktopBridge.connectBaskuleServer(link);
    await clearLocalAppData();
    window.location.replace("/");
  } else {
    window.location.assign(link);
  }
}

export function ReceiveConnectionDialog() {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const connecting = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!connecting.current) setOpen(value);
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <QrCodeIcon />
        {t("Scan or import a connection")}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Connect this device")}</DialogTitle>
        </DialogHeader>
        {open ? (
          <ReceiveConnectionPanel
            onConnect={async (target) => {
              connecting.current = true;
              await openConnectionTarget(target).finally(() => {
                connecting.current = false;
              });
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ReceiveState =
  | { kind: "entry" }
  | { kind: "camera" }
  | { kind: "reading" }
  | { kind: "review"; target: ConnectionTarget }
  | { kind: "connecting"; target: ConnectionTarget };

export function ReceiveConnectionPanel({
  onConnect,
}: {
  onConnect: (target: ConnectionTarget) => Promise<void>;
}) {
  const t = useTranslation();
  const [state, setState] = useState<ReceiveState>({ kind: "entry" });
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const submitting = useRef(false);
  useEffect(
    () => () => {
      operation.current += 1;
    },
    [],
  );

  const review = (value: string) => {
    operation.current += 1;
    try {
      const target = parseConnectionTarget(value);
      setState({ kind: "review", target });
      setError(null);
    } catch (cause) {
      setState({ kind: "entry" });
      setError(cause instanceof Error ? cause.message : t("Invalid connection link."));
    }
  };
  const importImage = async (file: File) => {
    const request = ++operation.current;
    setState({ kind: "reading" });
    setError(null);
    return (async () => {
      const value = await decodeQrImage(file);
      if (request !== operation.current) return;
      if (!value)
        throw new Error(t("No QR code found in this image. Try another image or paste a link."));
      review(value);
    })().catch(() => {
      if (request === operation.current) {
        setState({ kind: "entry" });
        setError(
          t("Could not read a connection QR from this image. Try another image or paste a link."),
        );
      }
    });
  };
  const confirm = async (target: ConnectionTarget) => {
    if (submitting.current) return;
    submitting.current = true;
    const request = ++operation.current;
    setState({ kind: "connecting", target });
    setError(null);
    return (async () => {
      await onConnect(target);
    })()
      .catch((cause: unknown) => {
        if (request === operation.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("Could not connect. Try again or paste a new link."),
          );
          setState({ kind: "review", target });
        }
      })
      .finally(() => {
        submitting.current = false;
      });
  };
  const reviewState = state.kind === "review" || state.kind === "connecting" ? state : null;
  return (
    <div className="flex flex-col gap-4 px-6 pb-6">
      {reviewState ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t("Connect this device to this Baskule server?")}
          </p>
          <p className="break-all text-sm font-medium">{reviewState.target.origin}</p>
          <p className="text-xs text-muted-foreground">
            {reviewState.target.code
              ? t(
                  "Continuing uses the one-time link to sign this device in. Only continue if you trust this server.",
                )
              : t("You may need to sign in after connecting.")}
          </p>
          <Button
            disabled={state.kind === "connecting"}
            onClick={() => void confirm(reviewState.target)}
          >
            {state.kind === "connecting" ? t("Connecting…") : t("Confirm connection")}
          </Button>
          <Button
            variant="outline"
            disabled={state.kind === "connecting"}
            onClick={() => {
              operation.current += 1;
              setState({ kind: "entry" });
              setError(null);
            }}
          >
            {t("Use another connection")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t(
              "Scan a Baskule connection QR, import its image, or paste a link. You will confirm the server before connecting.",
            )}
          </p>
          {state.kind === "camera" ? (
            <>
              <ConnectionCamera
                onResult={review}
                onError={() => {
                  setState({ kind: "entry" });
                  setError(
                    t(
                      "Could not use the camera. Check camera permission, import an image, or paste a link.",
                    ),
                  );
                }}
              />
              <Button variant="outline" onClick={() => setState({ kind: "entry" })}>
                {t("Stop camera")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                operation.current += 1;
                setError(null);
                setState({ kind: "camera" });
              }}
            >
              <CameraIcon />
              {t("Use camera")}
            </Button>
          )}
          <label className="flex flex-col gap-2 text-sm">
            {t("Import QR image")}
            <input
              type="file"
              accept="image/*"
              disabled={state.kind === "reading"}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importImage(file);
              }}
            />
          </label>
          {state.kind === "reading" ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("Reading QR image…")}
            </p>
          ) : null}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              review(address);
            }}
          >
            <FormField
              label={t("Server address or connection link")}
              value={address}
              onChange={(event) => {
                operation.current += 1;
                setState({ kind: "entry" });
                setAddress(event.currentTarget.value);
              }}
              required
            />
            <Button type="submit" disabled={!address.trim()}>
              {t("Review connection")}
            </Button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ConnectionCamera({
  onResult,
  onError,
}: {
  onResult: (value: string) => void;
  onError: (cause: unknown) => void;
}) {
  const t = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onResult, onError });
  useEffect(() => {
    callbacks.current = { onResult, onError };
  });
  useEffect(() => {
    const controller = new AbortController();
    if (video.current)
      void startQrCamera({
        video: video.current,
        signal: controller.signal,
        onResult: (value) => callbacks.current.onResult(value),
        onError: (cause) => callbacks.current.onError(cause),
      });
    return () => controller.abort();
  }, []);
  return (
    <video
      ref={video}
      muted
      playsInline
      aria-label={t("Connection QR camera")}
      className="aspect-video w-full rounded-lg bg-black object-cover"
    />
  );
}
