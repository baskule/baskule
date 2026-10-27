import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "../../i18n";
import { Button } from "../../components/ui/button";
import { StandalonePage } from "../../components/ui/standalone-page";
import { FormField, BaskuleWordmark } from "../ui";
import { parseConnectionTarget, type ConnectionTarget } from "../connect";
import { openConnectionTarget, ReceiveConnectionDialog } from "./ReceiveConnectionDialog";

export function DesktopServerForm({
  currentServer,
  initialAddress,
}: {
  currentServer?: string;
  initialAddress?: string;
}) {
  const t = useTranslation();
  const [address, setAddress] = useState(initialAddress ?? currentServer ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConnectionTarget | null>(null);
  const submitting = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!target) {
      try {
        setTarget(parseConnectionTarget(address));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("Invalid connection link."));
      }
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await openConnectionTarget(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not connect."));
      setBusy(false);
      submitting.current = false;
    }
  };
  const form = (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      {target ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {t("Connect this device to this Baskule server?")}
          </p>
          <p className="break-all text-sm font-medium">{target.origin}</p>
          {target.code ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "Continuing uses the one-time link to sign this device in. Only continue if you trust this server.",
              )}
            </p>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
            {t("Use another connection")}
          </Button>
        </div>
      ) : (
        <>
          <ReceiveConnectionDialog />
          <FormField
            label={t("Server address or connection link")}
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            autoFocus={!currentServer}
            required
          />
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !address.trim()}>
        {busy ? t("Connecting…") : target ? t("Confirm connection") : t("Review connection")}
      </Button>
    </form>
  );
  return currentServer ? (
    <details>
      <summary className="cursor-pointer break-all text-sm text-muted-foreground">
        {t("Change server")} · {currentServer}
      </summary>
      <div className="pt-4">{form}</div>
    </details>
  ) : initialAddress ? (
    form
  ) : (
    <StandalonePage tone="brand">
      <div className="flex flex-col gap-6">
        <BaskuleWordmark />
        <h1 className="text-2xl font-semibold">{t("Connect to a server")}</h1>
        {form}
      </div>
    </StandalonePage>
  );
}
