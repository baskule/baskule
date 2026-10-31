// baskule: the OAuth app an organization registers once per vendor, for services that don't let
// Baskule register itself. Write-only: the server only says whether one is saved.
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { pluginErrorText, pluginsApi, type VendorClient } from "../../plugins/api";
import { confirmAction, FormField, notifySuccess } from "../../ui";
import { CopyField } from "../../views/AddPersonDialog";
import { PageRow, PageSection } from "../../views/BaskulePage";

type Method = VendorClient["tokenEndpointAuthMethod"];
const METHODS: ReadonlyArray<Method> = ["client_secret_post", "client_secret_basic", "none"];

export function VendorSetup({
  vendor,
  name,
  configured,
  required,
  onChanged,
}: {
  readonly vendor: string;
  /** The service as people know it. */
  readonly name: string;
  readonly configured: boolean;
  /** A server of this vendor can't sign anyone in until an app is saved. */
  readonly required: boolean;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const [clientId, setClientId] = useState("");
  const [method, setMethod] = useState<Method>("client_secret_post");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callback = `${window.desktopBridge?.getBaskuleServer?.() ?? window.location.origin}/api/baskule/plugins/oauth/callback`;
  const needsSecret = method !== "none";

  const methodLabel = (value: Method) => {
    switch (value) {
      case "client_secret_post":
        return t("Client secret in the request (client_secret_post)");
      case "client_secret_basic":
        return t("Client secret as HTTP Basic (client_secret_basic)");
      case "none":
        return t("No client secret (none)");
    }
  };

  const save = async (client: VendorClient | null) => {
    setSaving(client ? "save" : "remove");
    setError(null);
    return (async () => {
      await pluginsApi.vendorSetup(vendor, client);
      setClientId("");
      setSecret("");
      notifySuccess(client ? t("Sign-in setup saved") : t("Sign-in setup removed"));
      await onChanged();
    })()
      .catch((cause: unknown) => {
        setError(pluginErrorText(cause, t("The sign-in setup could not be saved.")));
      })
      .finally(() => {
        setSaving(null);
      });
  };

  const remove = async () => {
    const confirmed = await confirmAction(
      t(
        "Remove the sign-in setup of {{name}}?\nEvery {{name}} account people connected is disconnected.",
        { name },
      ),
      "destructive",
    );
    if (confirmed) await save(null);
  };

  return (
    <PageSection
      title={t("Sign-in setup")}
      description={t(
        "Some services only let people sign in through an app your organization registers with them.",
      )}
    >
      <PageRow
        trailing={
          <Badge variant={configured ? "success" : required ? "warning" : "outline"}>
            {configured ? t("Saved") : t("Not saved")}
          </Badge>
        }
      >
        <span className="truncate text-sm text-foreground">
          {t("Your app at {{name}}", { name })}
        </span>
        <span className="text-xs text-muted-foreground">
          {configured
            ? t("People sign in to {{name}} through the app you saved.", { name })
            : required
              ? t("People can't connect their {{name}} account until you save this app.", {
                  name,
                })
              : t("Only needed if {{name}} doesn't let Baskule register itself.", { name })}
        </span>
      </PageRow>
      <form
        className="flex flex-col gap-3 px-3 py-3 sm:px-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!clientId.trim() || (needsSecret && !secret)) return;
          void save({
            clientId: clientId.trim(),
            tokenEndpointAuthMethod: method,
            ...(needsSecret ? { clientSecret: secret } : {}),
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <CopyField label={t("Callback address")} value={callback} />
          <p className="text-xs text-muted-foreground">
            {t("Register this address at {{name}} as the app's redirect URI.", { name })}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t("Client ID")}
            autoComplete="off"
            value={clientId}
            onChange={(event) => setClientId(event.currentTarget.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Label>{t("Client authentication")}</Label>
            <Select
              value={method}
              disabled={saving !== null}
              onValueChange={(value) => {
                if (value) setMethod(value as Method);
              }}
            >
              <SelectTrigger aria-label={t("Client authentication")}>
                <SelectValue>{(value: Method) => methodLabel(value)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {METHODS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {methodLabel(value)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        {needsSecret ? (
          <FormField
            label={t("Client secret")}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t(
            "Saved secrets are never shown again; saving replaces the current setup. Saving or removing it disconnects every {{name}} account people connected, and they connect again.",
            { name },
          )}
        </p>
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          {configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving !== null}
              onClick={() => void remove()}
            >
              {saving === "remove" ? <Spinner size="sm" /> : null}
              {t("Remove setup")}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            disabled={saving !== null || !clientId.trim() || (needsSecret && !secret)}
          >
            {saving === "save" ? <Spinner size="sm" /> : null}
            {t("Save setup")}
          </Button>
        </div>
      </form>
    </PageSection>
  );
}
