// baskule: how people sign in to a vendor that doesn't let Baskule register itself, set up once per vendor:
// Baskule sign-in in one click where the catalog offers it, or the organization's own app with its guided
// steps. An own app's ID and secret are write-only. Every change disconnects that vendor's accounts.
import type { VendorSignIn } from "@t3tools/contracts/baskule-catalog";
import type { VendorSetup, VendorSetupInput } from "@t3tools/contracts/baskule-plugins";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { msg, useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Label } from "../../../components/ui/label";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { cn } from "../../../lib/utils";
import { BaskuleApiError } from "../../api";
import { pluginErrorText, pluginsApi } from "../../plugins/api";
import { confirmAction, FormField, notifySuccess, useApiResource } from "../../ui";
import { CopyField } from "../../views/AddPersonDialog";

/** A catalog vendor's app recipe; absent for a plugin an admin brought. */
export type VendorApp = Extract<VendorSignIn, { client: "static" }>;
type OwnApp = Extract<NonNullable<VendorSetupInput>, { clientId: string }>;
type ClientMethod = OwnApp["tokenEndpointAuthMethod"];
type Mode = NonNullable<VendorSetup["mode"]>;
const METHODS: ReadonlyArray<ClientMethod> = ["client_secret_post", "client_secret_basic", "none"];

/** For a plugin an admin brought, whose vendor the catalog doesn't describe. */
const GENERIC_STEPS = [
  msg("Register an app at {{name}} and add this installation's callback address."),
  msg("Paste the client ID and client secret here."),
];

const LINK =
  "rounded-sm text-foreground/80 underline underline-offset-4 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const useVendorSetup = (vendor: string) => {
  const [load] = useState(() => () => pluginsApi.vendor(vendor));
  return useApiResource(load);
};

function ClientMethodField({
  value,
  onChange,
  disabled,
}: {
  readonly value: ClientMethod;
  readonly onChange: (value: ClientMethod) => void;
  readonly disabled: boolean;
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
        disabled={disabled}
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

/** The vendor's sign-in as a setup step: how people sign in, or what is left to choose. */
export function VendorSignInStep({
  number,
  vendor,
  name,
  app,
  configured,
  onChanged,
}: {
  readonly number: number;
  readonly vendor: string;
  /** The vendor as people know it. */
  readonly name: string;
  readonly app: VendorApp | undefined;
  readonly configured: boolean;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const setup = useVendorSetup(vendor);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = setup.data;
  const changed = () => Promise.all([setup.reload(), onChanged()]);

  const remove = async () => {
    const confirmed = await confirmAction(
      t(
        "Remove the sign-in setup of {{name}}?\nEvery {{name}} account people connected is disconnected.",
        { name },
      ),
      "destructive",
    );
    if (!confirmed) return;
    setRemoving(true);
    setError(null);
    return (async () => {
      await pluginsApi.vendorSetup(vendor, null);
      notifySuccess(t("Sign-in setup removed"));
      await changed();
    })()
      .catch((cause: unknown) => {
        setError(pluginErrorText(cause, t("The sign-in setup could not be saved.")));
      })
      .finally(() => {
        setRemoving(false);
      });
  };

  return (
    <SetupStep number={number} done={configured} title={t("Set up sign-in to {{name}}", { name })}>
      {!state ? (
        setup.error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {setup.error}
          </p>
        ) : (
          <Spinner size="sm" tone="muted" />
        )
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
            <p>
              {state.mode === "relay"
                ? t("Saved. People sign in to {{name}} with Baskule sign-in.", { name })
                : state.mode === "own"
                  ? t("Saved. People sign in to {{name}} through your own app.", { name })
                  : state.relaySupported
                    ? t("Turn on Baskule sign-in in one click, or use your own app at {{name}}.", {
                        name,
                      })
                    : t("Register an app at {{name}}, then save its client ID and secret here.", {
                        name,
                      })}
            </p>
            {state.tenant ? (
              <p className="[overflow-wrap:anywhere]">
                {t("Tenant: {{tenant}}", { tenant: state.tenant })}
              </p>
            ) : null}
          </div>
          {state.mode === null ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t("Set up sign-in")}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={removing} onClick={() => void remove()}>
                {removing ? <Spinner size="sm" /> : null}
                {t("Remove setup")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={t("Change how people sign in to {{name}}", { name })}
                disabled={removing}
                onClick={() => setOpen(true)}
              >
                {t("Change")}
              </Button>
            </div>
          )}
        </div>
      )}
      {state?.mode === "relay" && state.relayAvailable === false ? (
        <Alert variant="warning">
          <AlertDescription>
            {t(
              "Baskule sign-in isn't available for {{name}} right now. People can't connect new accounts until it is back, or until you switch to your own app.",
              { name },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="error" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {state ? (
        <VendorSignInDialog
          open={open}
          vendor={vendor}
          name={name}
          app={app}
          setup={state}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await changed();
          }}
        />
      ) : null}
    </SetupStep>
  );
}

/** A vendor app nobody needs yet: for a server that turns out not to let Baskule register itself. */
export function OptionalVendorApp({
  vendor,
  name,
  onChanged,
}: {
  readonly vendor: string;
  readonly name: string;
  readonly onChanged: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const setup = useVendorSetup(vendor);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">{t("Your own app at {{name}}", { name })}</span>
        <span className="text-xs text-muted-foreground">
          {t("Only needed if {{name}} doesn't let Baskule register itself.", { name })}
        </span>
        {setup.error && !setup.data ? (
          <span role="alert" className="text-xs text-destructive-foreground">
            {setup.error}
          </span>
        ) : null}
      </div>
      <Button size="sm" variant="outline" disabled={!setup.data} onClick={() => setOpen(true)}>
        {t("Set up")}
      </Button>
      {setup.data ? (
        <VendorSignInDialog
          open={open}
          vendor={vendor}
          name={name}
          app={undefined}
          setup={setup.data}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await Promise.all([setup.reload(), onChanged()]);
          }}
        />
      ) : null}
    </div>
  );
}

function VendorSignInDialog({
  open,
  onClose,
  ...form
}: {
  readonly open: boolean;
  readonly vendor: string;
  readonly name: string;
  readonly app: VendorApp | undefined;
  readonly setup: VendorSetup;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        {open ? <SignInForm {...form} busy={busy} setBusy={setBusy} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function SignInForm({
  vendor,
  name,
  app,
  setup,
  busy,
  setBusy,
  onClose,
  onSaved,
}: {
  readonly vendor: string;
  readonly name: string;
  readonly app: VendorApp | undefined;
  readonly setup: VendorSetup;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<unknown>;
}) {
  const t = useTranslation();
  const [mode, setMode] = useState<Mode>(setup.mode ?? (setup.relaySupported ? "relay" : "own"));
  const [tenant, setTenant] = useState(setup.tenant ?? "");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [method, setMethod] = useState<ClientMethod>("client_secret_post");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(
    setup.mode === "relay" && setup.relayAvailable === false,
  );
  const needsTenant = app?.fields?.includes("tenant") ?? false;
  const needsSecret = method !== "none";
  const tenantValue = tenant.trim();
  const withTenant = needsTenant ? { tenant: tenantValue } : {};
  const relay = mode === "relay";
  // Saving the same Baskule sign-in again would only disconnect everyone.
  const unchanged = relay && setup.mode === "relay" && tenantValue === (setup.tenant ?? "");
  const input: NonNullable<VendorSetupInput> | null =
    (needsTenant && !tenantValue) || unchanged
      ? null
      : relay
        ? { mode: "relay", ...withTenant }
        : clientId.trim() && (!needsSecret || secret)
          ? {
              clientId: clientId.trim(),
              tokenEndpointAuthMethod: method,
              ...(needsSecret ? { clientSecret: secret } : {}),
              ...withTenant,
            }
          : null;

  const save = async (chosen: NonNullable<VendorSetupInput>) => {
    if (setup.mode !== null) {
      const consequence = t(
        "Every {{name}} account people connected is disconnected. People connect again in Settings → Plugins.",
        { name },
      );
      const question =
        setup.mode === mode
          ? t("Replace the sign-in setup of {{name}}?", { name })
          : relay
            ? t("Switch {{name}} to Baskule sign-in?", { name })
            : t("Switch {{name}} to your own app?", { name });
      if (!(await confirmAction(`${question}\n${consequence}`, "destructive"))) return;
    }
    setBusy(true);
    setError(null);
    return (async () => {
      await pluginsApi.vendorSetup(vendor, chosen);
      notifySuccess(t("Sign-in setup saved"));
      await onSaved();
    })()
      .catch((cause: unknown) => {
        const code = cause instanceof BaskuleApiError ? cause.code : undefined;
        if (code === "relay_vendor_unavailable") setUnavailable(true);
        else if (relay && needsTenant && code === "invalid_oauth_client")
          setError(t("Check the tenant, then try again."));
        else setError(pluginErrorText(cause, t("The sign-in setup could not be saved.")));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const tenantField = needsTenant ? (
    <FormField
      label={t("Tenant")}
      autoComplete="off"
      value={tenant}
      disabled={busy}
      hint={t(
        "Your organization's directory (tenant) ID or primary domain, such as contoso.onmicrosoft.com.",
      )}
      onChange={(event) => setTenant(event.currentTarget.value)}
    />
  ) : null;

  return (
    <form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (input && !busy) void save(input);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("Set up sign-in to {{name}}", { name })}</DialogTitle>
        <DialogDescription>
          {setup.relaySupported
            ? t("Choose how people connect their {{name}} accounts.", { name })
            : t("People connect their {{name}} accounts through an app you register at {{name}}.", {
                name,
              })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {setup.relaySupported ? (
          <RadioGroup
            aria-label={t("How people sign in")}
            value={mode}
            disabled={busy}
            onValueChange={(value) => {
              setMode(value as Mode);
              setError(null);
            }}
          >
            <div className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
              {(
                [
                  [
                    "relay",
                    t("Baskule sign-in"),
                    t(
                      "One click. People sign in through Baskule's {{name}} app; there is nothing to register.",
                      { name },
                    ),
                  ],
                  [
                    "own",
                    t("Your own app"),
                    t("Register an app at {{name}} and paste its client ID and secret here.", {
                      name,
                    }),
                  ],
                ] as const
              ).map(([value, label, detail]) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                  <span className="pt-0.5">
                    <Radio value={value} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      {label}
                      {value === "relay" ? (
                        <Badge variant="info" size="sm">
                          {t("Recommended")}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </RadioGroup>
        ) : null}

        {relay ? (
          <>
            {tenantField}
            <p className="text-xs text-muted-foreground">
              {t(
                "People confirm on a Baskule page, then sign in at {{name}}. Baskule's sign-in service stores no accounts or tokens.",
                { name },
              )}
            </p>
            {unavailable ? (
              <Alert variant="warning" role="alert">
                <AlertDescription>
                  {t(
                    "Baskule sign-in isn't available for {{name}} right now. Use your own app instead, or try again later.",
                    { name },
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : (
          <>
            {app?.ownAppLimit ? (
              <Alert variant="info">
                <AlertDescription>{t(app.ownAppLimit)}</AlertDescription>
              </Alert>
            ) : null}
            <OwnAppSteps
              name={name}
              steps={app?.ownApp ?? GENERIC_STEPS}
              docs={app?.docs}
              callbackUrl={setup.callbackUrl}
            />
            {tenantField}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={t("Client ID")}
                autoComplete="off"
                value={clientId}
                disabled={busy}
                onChange={(event) => setClientId(event.currentTarget.value)}
              />
              {needsSecret ? (
                <FormField
                  label={t("Client secret")}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  disabled={busy}
                  onChange={(event) => setSecret(event.currentTarget.value)}
                />
              ) : null}
            </div>
            <ClientMethodField value={method} onChange={setMethod} disabled={busy} />
            <p className="text-xs text-muted-foreground">
              {t("Stored encrypted and never shown again.")}
            </p>
          </>
        )}

        {setup.mode !== null && !unchanged ? (
          <p className="text-xs text-muted-foreground">
            {t("Saving disconnects every {{name}} account people connected.", { name })}
          </p>
        ) : null}
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={busy || !input}>
          {busy ? <Spinner size="sm" /> : null}
          {relay ? t("Use Baskule sign-in") : t("Save setup")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What to do at the vendor, numbered, with the callback address at the step that registers it. */
function OwnAppSteps({
  name,
  steps,
  docs,
  callbackUrl,
}: {
  readonly name: string;
  /** English catalog text, translated here. */
  readonly steps: ReadonlyArray<string>;
  readonly docs: string | undefined;
  readonly callbackUrl: string;
}) {
  const t = useTranslation();
  const callbackStep = steps.findIndex((step) => step.includes("callback"));
  const callback = <CopyField label={t("Callback address")} value={callbackUrl} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-foreground">{t("At {{name}}", { name })}</span>
        {docs ? (
          <a
            href={docs}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(LINK, "inline-flex items-center gap-1 text-sm [&_svg]:size-3.5")}
          >
            {t("Setup instructions")}
            <ExternalLinkIcon aria-hidden />
          </a>
        ) : null}
      </div>
      <ol aria-label={t("Steps at {{name}}", { name })} className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-2xs tabular-nums text-muted-foreground"
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-sm text-foreground/90 [overflow-wrap:anywhere]">
                {withLinks(t(step, { name }))}
              </p>
              {index === callbackStep ? callback : null}
            </div>
          </li>
        ))}
      </ol>
      {callbackStep < 0 ? callback : null}
    </div>
  );
}

/** Addresses in a step's text as links, without the punctuation that ends a sentence. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(https:\/\/\S+?)(?=[.,;:)]?(?:\s|$))/).map((part, index) =>
    index % 2 ? (
      <a key={part} href={part} target="_blank" rel="noreferrer noopener" className={LINK}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
