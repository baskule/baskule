import { useTranslation } from "../../../i18n";
// baskule: General → Authentication: installer-managed providers and admin-managed Google signup.
import { useState, type FormEvent } from "react";
import { KeyRoundIcon, LogInIcon, UsersIcon } from "lucide-react";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { baskuleApi, type BaskuleAdminSettings } from "../../api";
import { errorText, FormField, notifySuccess, useApiResource } from "../../ui";
import { saveSettingsPart } from "../settings";
import { Badge } from "../../../components/ui/badge";
import { useBaskuleMe } from "../../session";
import { RowIcon } from "../../ui";
import { CopyField } from "../../views/AddPersonDialog";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";

export function AuthenticationPage() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const settings = useApiResource(baskuleApi.adminSettings);
  if (me === null) return null;
  const { mode, password, providers } = me.authentication;
  const anonymous = mode === "anonymous";
  return (
    <>
      {anonymous ? (
        <Alert>
          <AlertDescription>
            {t(
              "Anonymous test installation. Everyone shares this workspace and can administer it.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <PageSection
        title={t("Access")}
        description={t("Set by the installer in auth.json. Changes need a redeploy.")}
      >
        <PageRow
          leading={
            <RowIcon>
              <UsersIcon />
            </RowIcon>
          }
        >
          <span className="text-sm text-foreground">
            {anonymous ? t("Anonymous access") : t("Account access")}
          </span>
          <span className="text-xs text-muted-foreground">
            {anonymous
              ? t("Anyone who can open this address uses the shared workspace, without signing in.")
              : t(
                  "Invite people under People → Users, or allow Google signup for your domains below.",
                )}
          </span>
        </PageRow>
      </PageSection>
      {!anonymous &&
      providers.some((provider) => provider.id === "google" && provider.type === "social") ? (
        settings.data ? (
          <GoogleSignupForm initial={settings.data} />
        ) : (
          <PageMessage>{settings.error ?? <Spinner />}</PageMessage>
        )
      ) : null}
      {anonymous ? null : (
        <PageSection title={t("Sign-in methods")}>
          {!password && providers.length === 0 ? (
            <PageMessage>{t("No sign-in method is configured.")}</PageMessage>
          ) : null}
          {password ? (
            <PageRow
              leading={
                <RowIcon>
                  <KeyRoundIcon />
                </RowIcon>
              }
              trailing={<Badge variant="success">{t("On")}</Badge>}
            >
              <span className="text-sm text-foreground">{t("Email and password")}</span>
              <span className="text-xs text-muted-foreground">
                {t(
                  "People sign in with the password you set or that they chose from an invitation.",
                )}
              </span>
            </PageRow>
          ) : null}
          {providers.map((provider) => (
            <div key={provider.id} className="flex flex-col gap-3 px-3 py-3 sm:px-4">
              <div className="flex items-center gap-3">
                <RowIcon>
                  <LogInIcon />
                </RowIcon>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">{provider.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {provider.type === "oidc"
                      ? t("Single sign-on (OpenID Connect)")
                      : t("Social sign-in")}
                  </span>
                </span>
                <Badge variant="success">{t("On")}</Badge>
              </div>
              <div className="flex max-w-xl flex-col gap-1.5 sm:ps-10">
                <CopyField
                  label={t("Callback URL")}
                  value={`${window.desktopBridge?.getBaskuleServer?.() ?? window.location.origin}/auth/callback/${provider.id}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Register this address at {{provider}} as the redirect URL.", {
                    provider: provider.name,
                  })}
                </p>
              </div>
            </div>
          ))}
        </PageSection>
      )}
    </>
  );
}

function GoogleSignupForm({ initial }: { readonly initial: BaskuleAdminSettings }) {
  const t = useTranslation();
  const [domains, setDomains] = useState(initial.googleSignupDomains.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    return (async () => {
      const saved = await saveSettingsPart({
        googleSignupDomains: domains.split(/[,\s]+/).filter(Boolean),
      });
      setDomains(saved.googleSignupDomains.join(", "));
      notifySuccess(t("Google signup settings saved"));
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t("Could not save settings.")));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <PageSection
        title={t("Google signup")}
        description={t(
          "Changes apply immediately. New users become members with their own personal workspace.",
        )}
      >
        <fieldset disabled={busy} className="flex flex-col gap-4 p-4">
          <FormField
            className="max-w-md"
            label={t("Allowed email domains")}
            value={domains}
            onChange={(event) => setDomains(event.currentTarget.value)}
            placeholder="company.com"
            hint={t(
              "Separate domains with commas. Leave empty to require invitations. Google must verify the email and its Workspace domain.",
            )}
          />
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner size="sm" /> : null}
              {t("Save settings")}
            </Button>
          </div>
        </fieldset>
      </PageSection>
    </form>
  );
}
