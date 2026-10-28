import { useState, type FormEvent } from "react";
import { decodePushAvailability } from "@t3tools/contracts/baskulePush";
import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { request } from "../../api";
import { FormField, errorText, notifySuccess, useApiResource } from "../../ui";
import { PageSection } from "../../views/BaskulePage";

const loadStatus = async () =>
  decodePushAvailability(await request("GET", "/api/baskule/admin/push"));
export function PushSettings() {
  const t = useTranslation();
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
          throw new Error(t("Enter the Firebase service-account JSON file contents."));
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
      notifySuccess(t("Push configuration saved"));
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t("Could not save push configuration.")));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <PageSection
      title={t("Mobile notifications")}
      description={t(
        "Configure delivery for your signed mobile app. Saved credentials are write-only.",
      )}
    >
      <form className="flex max-w-xl flex-col gap-4 p-4" onSubmit={(event) => void save(event)}>
        <p className="text-sm text-muted-foreground">
          {status.data
            ? `${t("Android")}: ${status.data.android?.appId ?? t("Not configured")}. ${t("iOS")}: ${status.data.ios?.appId ?? t("Not configured")}.`
            : (status.error ?? t("Loading"))}
        </p>
        <fieldset disabled={busy} className="flex flex-col gap-4">
          <div className="flex gap-4">
            <label>
              <input
                type="radio"
                name="push-provider"
                checked={provider === "fcm"}
                onChange={() => {
                  setProvider("fcm");
                  setSecret("");
                }}
              />{" "}
              {t("Android (Firebase)")}
            </label>
            <label>
              <input
                type="radio"
                name="push-provider"
                checked={provider === "apns"}
                onChange={() => {
                  setProvider("apns");
                  setSecret("");
                }}
              />{" "}
              {t("iOS (APNs)")}
            </label>
          </div>
          <FormField
            label={provider === "fcm" ? t("Android application ID") : t("iOS bundle ID")}
            value={appId}
            onChange={(e) => setAppId(e.currentTarget.value)}
            required
            maxLength={200}
          />
          {provider === "apns" ? (
            <>
              <FormField
                label={t("Apple team ID")}
                value={teamId}
                onChange={(e) => setTeamId(e.currentTarget.value)}
                required
              />
              <FormField
                label={t("APNs key ID")}
                value={keyId}
                onChange={(e) => setKeyId(e.currentTarget.value)}
                required
              />
              <label>
                <input
                  type="checkbox"
                  checked={sandbox}
                  onChange={(e) => setSandbox(e.currentTarget.checked)}
                />{" "}
                {t("Use the APNs sandbox for a development build")}
              </label>
            </>
          ) : null}
          <label className="flex flex-col gap-2 text-sm">
            {provider === "apns" ? t("APNs private key (.p8)") : t("Firebase service-account JSON")}
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
              {t("Save provider")}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={(event) => void save(event, true)}
            >
              {t("Remove provider")}
            </Button>
          </div>
        </fieldset>
      </form>
    </PageSection>
  );
}
