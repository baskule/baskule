// baskule: the OAuth app an organization registers once per vendor, for services that don't let
// Baskule register itself, as two setup steps. Write-only: the server only says whether one is saved.
// The callback address and client authentication live under the page's technical details.
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
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
import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { cn } from "../../../lib/utils";
import { pluginErrorText, pluginsApi, type VendorClient } from "../../plugins/api";
import { confirmAction, FormField, notifySuccess } from "../../ui";

export type ClientMethod = VendorClient["tokenEndpointAuthMethod"];
const METHODS: ReadonlyArray<ClientMethod> = ["client_secret_post", "client_secret_basic", "none"];

/** Where the vendor sends people back after they sign in. */
export const vendorCallback = () =>
  `${window.desktopBridge?.getBaskuleServer?.() ?? window.location.origin}/api/baskule/plugins/oauth/callback`;

export function ClientMethodField({
  value,
  onChange,
}: {
  readonly value: ClientMethod;
  readonly onChange: (value: ClientMethod) => void;
}) {
  const t = useTranslation();
  const label = (method: ClientMethod) => {
    switch (method) {
      case "client_secret_post":
        return t("Client secret in the request (client_secret_post)");
      case "client_secret_basic":
        return t("Client secret as HTTP Basic (client_secret_basic)");
      case "none":
        return t("No client secret (none)");
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t("Client authentication")}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as ClientMethod);
        }}
      >
        <SelectTrigger aria-label={t("Client authentication")}>
          <SelectValue>{(method: ClientMethod) => label(method)}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {METHODS.map((method) => (
            <SelectItem key={method} value={method}>
              {label(method)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** One numbered step of a plugin's setup; a done step shows a check instead of its number. */
export function SetupStep({
  number,
  done,
  title,
  children,
}: {
  readonly number: number;
  readonly done: boolean;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  const t = useTranslation();
  return (
    <li className="flex gap-3 px-3 py-3 sm:px-4">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
          done
            ? "border-success/40 bg-success/8 text-success-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <span className="text-sm text-foreground">
          {title}
          <span className="sr-only">{done ? ` (${t("done")})` : ` (${t("to do")})`}</span>
        </span>
        {children}
      </div>
    </li>
  );
}

function CopyCallbackButton() {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void writeTextToClipboard(vendorCallback()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? t("Copied") : t("Copy Baskule's address")}
    </Button>
  );
}

/** The two steps of a vendor app: create it at the vendor, then save its ID and secret here. */
export function VendorSetupSteps({
  vendor,
  name,
  configured,
  docs,
  method,
  first,
  onChanged,
}: {
  readonly vendor: string;
  /** The service as people know it. */
  readonly name: string;
  readonly configured: boolean;
  /** The vendor's instructions for registering the app. */
  readonly docs?: string | undefined;
  readonly method: ClientMethod;
  /** The number of the first of the two steps. */
  readonly first: number;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const [replacing, setReplacing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsSecret = method !== "none";
  const complete = clientId.trim() !== "" && (!needsSecret || secret !== "");
  const editing = !configured || replacing;

  const save = async (client: VendorClient | null) => {
    setSaving(client ? "save" : "remove");
    setError(null);
    return (async () => {
      await pluginsApi.vendorSetup(vendor, client);
      setClientId("");
      setSecret("");
      setReplacing(false);
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
    <>
      <SetupStep
        number={first}
        done={configured}
        title={t("Create an app at {{name}}", { name })}
      >
        {configured ? null : (
          <>
            <p className="text-xs text-muted-foreground">
              {t("When {{name}} asks where to send people back, give it Baskule's address.", {
                name,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <CopyCallbackButton />
              {docs ? (
                <a
                  href={docs}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 rounded-sm text-sm text-foreground/80 underline underline-offset-4 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"
                >
                  {t("Setup instructions")}
                  <ExternalLinkIcon aria-hidden />
                </a>
              ) : null}
            </div>
          </>
        )}
      </SetupStep>
      <SetupStep
        number={first + 1}
        done={configured}
        title={t("Save the app's ID and secret here")}
      >
        {editing ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!complete) return;
              void save({
                clientId: clientId.trim(),
                tokenEndpointAuthMethod: method,
                ...(needsSecret ? { clientSecret: secret } : {}),
              });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={t("Client ID")}
                autoComplete="off"
                value={clientId}
                onChange={(event) => setClientId(event.currentTarget.value)}
              />
              {needsSecret ? (
                <FormField
                  label={t("Client secret")}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(event) => setSecret(event.currentTarget.value)}
                />
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {configured
                ? t(
                    "Saving replaces the current app and disconnects every {{name}} account people connected.",
                    { name },
                  )
                : t("Stored encrypted and never shown again.")}
            </p>
            {error ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex justify-end gap-2">
              {replacing ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={saving !== null}
                  onClick={() => setReplacing(false)}
                >
                  {t("Cancel")}
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={saving !== null || !complete}>
                {saving === "save" ? <Spinner size="sm" /> : null}
                {t("Save setup")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("Saved. People sign in to {{name}} through this app.", { name })}
            </p>
            <div className="flex gap-2">
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
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("Replace the app at {{name}}", { name })}
                disabled={saving !== null}
                onClick={() => setReplacing(true)}
              >
                {t("Replace")}
              </Button>
            </div>
          </div>
        )}
        {!editing && error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </SetupStep>
    </>
  );
}
