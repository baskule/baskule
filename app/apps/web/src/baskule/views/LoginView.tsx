import { t, useTranslation } from "../../i18n";

// baskule: sign-in methods come from the installation's Better Auth configuration.
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { StandalonePage } from "../../components/ui/standalone-page";
import { BaskuleApiError, baskuleApi } from "../api";
import { safeNextPath } from "../session";
import { FormField, BaskuleWordmark, useApiResource } from "../ui";
import { DesktopServerForm } from "./DesktopServerForm";
import { BrowserSignInButton } from "./BrowserSignInButton";
import { ReceiveConnectionDialog } from "./ReceiveConnectionDialog";

export function signInErrorMessage(error: unknown): string {
  if (error instanceof BaskuleApiError) {
    if (error.status === 401 || error.code === "INVALID_EMAIL_OR_PASSWORD") {
      return t("That email and password don't match an account.");
    }
    if (error.status === 403 || error.code === "BANNED_USER") {
      return t("This account is deactivated. Ask your administrator.");
    }
    if (error.status === 429) return t("Too many attempts. Wait a minute and try again.");
    return error.message;
  }
  return t("Sign-in failed. Try again.");
}

export function LoginView({ next }: { readonly next: string | null }) {
  useTranslation();
  const server = window.desktopBridge?.getBaskuleServer?.();
  if (window.desktopBridge?.connectBaskuleServer && !server) return <DesktopServerForm />;
  return <AccountLoginView next={next} server={server ?? null} />;
}

function AccountLoginView({ next, server }: { next: string | null; server: string | null }) {
  const t = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useApiResource(baskuleApi.authConfig);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await baskuleApi.signIn({ email: email.trim(), password });
      // A full load starts every space connection with the new session.
      window.location.assign(safeNextPath(next));
    } catch (cause) {
      setError(signInErrorMessage(cause));
      setSubmitting(false);
    }
  };

  return (
    <StandalonePage>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <BaskuleWordmark className="text-base" />
          <h1 className="text-2xl font-semibold tracking-tight">{t("Sign in")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Sign in with your organization account.")}
          </p>
        </div>
        <ReceiveConnectionDialog />
        {server ? <DesktopServerForm currentServer={server} /> : null}
        {config.error ? (
          <Alert variant="error">
            <AlertDescription>{config.error}</AlertDescription>
          </Alert>
        ) : null}
        {new URLSearchParams(window.location.search).has("error") ? (
          <Alert variant="error">
            <AlertDescription>
              {t(
                "Sign-in could not be completed. Use your organization’s Google Workspace account or accept an invitation first.",
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {config.loading && !config.data ? <Spinner /> : null}
        {window.desktopBridge !== undefined && config.data?.providers.length ? (
          <BrowserSignInButton next={safeNextPath(next)} onError={setError} />
        ) : (
          config.data?.providers.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true);
                void baskuleApi.providerSignIn(provider, safeNextPath(next)).then(
                  (result) => window.location.assign(result.url),
                  (cause) => {
                    setError(signInErrorMessage(cause));
                    setSubmitting(false);
                  },
                );
              }}
            >
              {t("Continue with {{provider}}", { provider: provider.name })}
            </Button>
          ))
        )}
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {config.data?.password ? (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <FormField
              label={t("Email")}
              type="email"
              name="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            <FormField
              label={t("Password")}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <Button type="submit" disabled={submitting || !email.trim() || !password}>
              {submitting ? <Spinner size="sm" /> : null}
              {submitting ? t("Signing in…") : t("Sign in")}
            </Button>
          </form>
        ) : null}
      </div>
    </StandalonePage>
  );
}
