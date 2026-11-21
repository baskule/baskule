import { useMessages, msg } from "gt-react";

import { useState, type FormEvent } from "react";
import { decodePushAvailability } from "@t3tools/contracts/baskulePush";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { request } from "../../api";
import { FormField, errorText, notifySuccess, useApiResource } from "../../ui";
import { PageSection } from "../../views/BaskulePage";

const loadStatus = async () =>
  decodePushAvailability(await request("GET", "/api/baskule/admin/push"));
export function PushSettings() {
  const t = useMessages();
  const status = useApiResource(loadStatus);
  const [provider, setProvider] = useState<"apns" | "fcm">("fcm");
  const [appId, setAppId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [sandbox, setSandbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent, clear = false) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    return (async () => {
      let value: unknown = null;
      if (!clear && provider === "apns")
        value = {
          appId,
          teamId,
          keyId,
          privateKey: secret,
          environments: [sandbox ? "sandbox" : "production"],
        };
      if (!clear && provider === "fcm") {
        const account: unknown = JSON.parse(secret);
        if (
          !account ||
          typeof account !== "object" ||
          !("project_id" in account) ||
          !("client_email" in account) ||
          !("private_key" in account)
        )
          throw new Error(t(msg("Enter the Firebase service-account JSON file contents.")));
        value = {
          appId,
          projectId: account.project_id,
          clientEmail: account.client_email,
          privateKey: account.private_key,
        };
      }
      await request("PATCH", "/api/baskule/admin/push", { [provider]: value });
      setSecret("");
      status.reload();
      notifySuccess(t(msg("Push configuration saved")));
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t(msg("Could not save push configuration."))));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <PageSection
      title={t(msg("Mobile notifications"))}
      description={t(msg("Configure delivery for your signed mobile app. Saved credentials are write-only."))}
    >
      <form className="flex max-w-xl flex-col gap-4 p-4" onSubmit={(event) => void save(event)}>
        <p className="text-sm text-muted-foreground">
          {status.data
            ? `${t(msg("Android"))}: ${status.data.android?.appId ?? t(msg("Not configured"))}. ${t(msg("iOS"))}: ${status.data.ios?.appId ?? t(msg("Not configured"))}.`
            : (status.error ?? t(msg("Loading")))}
        </p>
        <fieldset disabled={busy} className="flex flex-col gap-4">
          <div className="flex gap-4">
            <label>
              <input
                type="radio"
                className="accent-primary"
                name="push-provider"
                checked={provider === "fcm"}
                onChange={() => {
                  setProvider("fcm");
                  setSecret("");
                }}
              />{" "}
              {t(msg("Android (Firebase)"))}
            </label>
            <label>
              <input
                type="radio"
                className="accent-primary"
                name="push-provider"
                checked={provider === "apns"}
                onChange={() => {
                  setProvider("apns");
                  setSecret("");
                }}
              />{" "}
              {t(msg("iOS (APNs)"))}
            </label>
          </div>
          <FormField
            label={provider === "fcm" ? t(msg("Android application ID")) : t(msg("iOS bundle ID"))}
            value={appId}
            onChange={(e) => setAppId(e.currentTarget.value)}
            required
            maxLength={200}
          />
          {provider === "apns" ? (
            <>
              <FormField
                label={t(msg("Apple team ID"))}
                value={teamId}
                onChange={(e) => setTeamId(e.currentTarget.value)}
                required
              />
              <FormField
                label={t(msg("APNs key ID"))}
                value={keyId}
                onChange={(e) => setKeyId(e.currentTarget.value)}
                required
              />
              <label>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={sandbox}
                  onChange={(e) => setSandbox(e.currentTarget.checked)}
                />{" "}
                {t(msg("Use the APNs sandbox for a development build"))}
              </label>
            </>
          ) : null}
          <label className="flex flex-col gap-2 text-sm">
            {provider === "apns" ? t(msg("APNs private key (.p8)")) : t(msg("Firebase service-account JSON"))}
            <Textarea
              value={secret}
              onChange={(e) => setSecret(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              required
              rows={5}
            />
          </label>
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-3">
            <Button type="submit" disabled={busy}>
              {t(msg("Save provider"))}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={(event) => void save(event, true)}
            >
              {t(msg("Remove provider"))}
            </Button>
          </div>
        </fieldset>
      </form>
    </PageSection>
  );
}
