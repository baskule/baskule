// baskule: registering one OAuth client for an authorization server that refuses automatic
// registration. The callback URL comes first: the vendor asks for it before it gives a client ID.
import { ISSUER_DEFAULT_PARAMS, type OAuthClientSetup } from "@t3tools/contracts/baskule-plugins";
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Spinner } from "../../../components/ui/spinner";
import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { useTranslation } from "../../../i18n";
import { defaultCallbackUrl, pluginErrorText, pluginsApi } from "../../plugins/api";
import { FormField, notifySuccess } from "../../ui";
import { signInGuide } from "./signInGuides";

/** What the server knows about the issuer's client, or an empty one before any plugin uses it. */
export function oauthClientFor(
  clients: ReadonlyArray<OAuthClientSetup>,
  issuer: string,
  hosts: ReadonlyArray<string> = [],
): OAuthClientSetup {
  const found = clients.find((client) => client.issuer === issuer);
  return (
    found ?? {
      issuer,
      configured: false,
      clientId: null,
      hasSecret: false,
      scopes: null,
      authorizationParams: null,
      callbackUrl: clients[0]?.callbackUrl ?? defaultCallbackUrl(),
      hosts: [...hosts],
      usedBy: [],
    }
  );
}

export function SignInSetup({
  client,
  onSaved,
}: {
  readonly client: OAuthClientSetup;
  readonly onSaved: () => Promise<void> | void;
}) {
  const t = useTranslation();
  const titleId = useId();
  const guide = signInGuide(client.issuer);
  const defaults = ISSUER_DEFAULT_PARAMS[client.issuer] ?? "";
  const [clientId, setClientId] = useState(client.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState(client.scopes ?? "");
  const [params, setParams] = useState(client.authorizationParams || defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await pluginsApi.saveOAuthClient({
        issuer: client.issuer,
        clientId: clientId.trim(),
        ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
        ...(scopes.trim() ? { scopes: scopes.trim() } : {}),
        ...(params.trim() ? { authorizationParams: params.trim() } : {}),
      });
      setSecret("");
      notifySuccess(t("Sign-in to {{vendor}} is set up", { vendor: guide.vendor }));
      await onSaved();
    } catch (cause) {
      setError(pluginErrorText(cause, t("The OAuth client could not be saved.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-lg border border-border/60 bg-background p-3 sm:p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (clientId.trim() && !saving) void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {client.configured
            ? t("Sign-in to {{vendor}}", { vendor: guide.vendor })
            : t("Set up sign-in to {{vendor}}", { vendor: guide.vendor })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "{{vendor}} doesn't let Baskule register itself. Register one OAuth client for your organization; every plugin that signs in with {{vendor}} uses it.",
            { vendor: guide.vendor },
          )}
        </p>
      </div>
      <CallbackUrl value={client.callbackUrl} />
      <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm text-foreground marker:text-muted-foreground">
        {guide.steps(client.hosts).map((step) => (
          <li key={step.text} className="ps-1">
            <span>{step.text}</span>
            {step.links?.length ? (
              <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {step.links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-sm text-sm text-foreground underline underline-offset-4 [overflow-wrap:anywhere] hover:text-foreground/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {link.label}
                    <ArrowUpRightIcon
                      aria-hidden
                      className="ms-0.5 inline size-3.5 align-text-top"
                    />
                  </a>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("Client ID")}
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          onChange={(event) => setClientId(event.currentTarget.value)}
        />
        <FormField
          label={t("Client secret")}
          type="password"
          autoComplete="new-password"
          placeholder={client.hasSecret ? t("Saved. Leave empty to keep it.") : ""}
          value={secret}
          onChange={(event) => setSecret(event.currentTarget.value)}
        />
        <FormField
          label={t("Scopes (optional)")}
          spellCheck={false}
          placeholder={guide.scopesPlaceholder}
          value={scopes}
          onChange={(event) => setScopes(event.currentTarget.value)}
        />
        <FormField
          label={t("Authorization parameters (optional)")}
          spellCheck={false}
          placeholder={defaults || "access_type=offline"}
          value={params}
          onChange={(event) => setParams(event.currentTarget.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!clientId.trim() || saving}>
          {saving ? <Spinner size="sm" /> : null}
          {t("Save OAuth client")}
        </Button>
      </div>
    </form>
  );
}

/** The redirect URI, wrapped so a phone shows all of it, with a copy button. */
function CallbackUrl({ value }: { readonly value: string }) {
  const t = useTranslation();
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={id} render={<span />}>
        {t("Callback URL")}
      </Label>
      <div className="flex items-start gap-2">
        <output
          aria-labelledby={id}
          className="min-w-0 flex-1 rounded-lg border border-input bg-muted/40 px-3 py-1.5 font-mono text-sm text-foreground select-all [overflow-wrap:anywhere]"
        >
          {value}
        </output>
        <Button
          variant="outline"
          size="icon"
          aria-label={t("Copy the callback URL")}
          onClick={() => {
            void writeTextToClipboard(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}
