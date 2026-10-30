import { t, useTranslation } from "../../i18n";

// baskule: accepting an invitation link: the invited person sets their name and password.
import { useEffect, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { StandalonePage } from "../../components/ui/standalone-page";
import { type Invitation, BaskuleApiError, baskuleApi } from "../api";
import { FormField, BaskuleWordmark, useApiResource } from "../ui";

export const MIN_PASSWORD_LENGTH = 8;

export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return t("Use at least {{MIN_PASSWORD_LENGTH}} characters.", {
      MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
    });
  }
  if (confirmation.length > 0 && password !== confirmation) return t("The passwords don't match.");
  return null;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly invitation: Invitation }
  | { readonly status: "invalid"; readonly message: string };

function invitationErrorMessage(error: unknown): string {
  if (error instanceof BaskuleApiError) {
    if (error.status === 404) {
      return t("This invitation link is not valid, has expired or was already used.");
    }
    return error.message;
  }
  return t("The invitation could not be loaded.");
}

/** Links carry the token in the fragment (`/invite#token=…`), so it never reaches a server log. */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token")?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export function InvitationView({ token }: { readonly token: string | null }) {
  const config = useApiResource(baskuleApi.authConfig);
  const t = useTranslation();
  const [state, setState] = useState<LoadState>(() =>
    token === null
      ? { status: "invalid", message: t("This link has no invitation in it. Copy the whole link.") }
      : { status: "loading" },
  );
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel publication of the invitation HTTP response after navigation or token change.
  useEffect(() => {
    let cancelled = false;
    if (token === null) return;
    baskuleApi.invitation(token).then(
      (invitation) => {
        if (cancelled) return;
        setState({ status: "ready", invitation });
      },
      (cause: unknown) => {
        if (!cancelled) setState({ status: "invalid", message: invitationErrorMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const problem = passwordProblem(password, confirmation);
  const mismatch = confirmation.length > 0 && password !== confirmation;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowProblems(true);
    if (submitting || !token || !name.trim() || problem !== null || password !== confirmation) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await baskuleApi.acceptInvitation(token, { name: name.trim(), password });
      window.location.assign("/");
    } catch (cause) {
      setError(invitationErrorMessage(cause));
      setSubmitting(false);
    }
  };

  return (
    <StandalonePage>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <BaskuleWordmark className="text-base" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {state.status === "invalid" ? t("Invitation unavailable") : t("Join Baskule")}
          </h1>
          {state.status === "ready" ? (
            <p className="text-sm text-muted-foreground">
              {t("You were invited")}
              {state.invitation.spaces.length > 0
                ? t(" to {{value1}}", {
                    value1: state.invitation.spaces
                      .map((space) => space.name ?? "a space")
                      .join(", "),
                  })
                : ""}
              {state.invitation.role === "admin" ? t(" as an administrator") : ""}
              {t(". Choose the name others will see, then choose how to sign in.")}
            </p>
          ) : null}
        </div>
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            {t("Checking the invitation…")}
          </p>
        ) : state.status === "invalid" ? (
          <div className="flex flex-col gap-4">
            <Alert variant="error" role="alert">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground">
              {t(
                "Ask your administrator for a new link, or sign in if you already have an account.",
              )}
            </p>
            <Button variant="outline" render={<a href="/login" />}>
              {t("Go to sign in")}
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <FormField
              label={t("Email")}
              type="email"
              value={state.invitation.email}
              disabled
              readOnly
            />
            <FormField
              label={t("Your name")}
              name="name"
              autoComplete="name"
              autoFocus
              required
              value={name}
              error={showProblems && !name.trim() ? "Enter your name." : null}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            {config.data?.password ? (
              <>
                <FormField
                  label={t("Password")}
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  required
                  value={password}
                  hint={t("At least {{MIN_PASSWORD_LENGTH}} characters.", {
                    MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
                  })}
                  error={showProblems && password.length < MIN_PASSWORD_LENGTH ? problem : null}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
                <FormField
                  label={t("Confirm password")}
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  required
                  value={confirmation}
                  error={mismatch ? t("The passwords don't match.") : null}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                />
              </>
            ) : null}
            {error ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {config.error ? (
              <Alert variant="error">
                <AlertDescription>{config.error}</AlertDescription>
              </Alert>
            ) : null}
            {config.data?.providers.map((provider) => (
              <Button
                type="button"
                variant="outline"
                key={provider.id}
                disabled={submitting || !name.trim()}
                onClick={() => {
                  if (!token) return;
                  setSubmitting(true);
                  setError(null);
                  void baskuleApi
                    .acceptProviderInvitation(token, name.trim(), provider.id)
                    .then(() => {
                      if (navigator.userAgent.includes("BaskuleDesktop/")) {
                        window.location.assign("/login");
                        return { url: "/login" };
                      }
                      return baskuleApi.providerSignIn(provider);
                    })
                    .then(
                      (result) => window.location.assign(result.url),
                      (cause) => {
                        setError(invitationErrorMessage(cause));
                        setSubmitting(false);
                      },
                    );
                }}
              >
                {t("Join with {{provider}}", { provider: provider.name })}
              </Button>
            ))}
            {config.data?.password ? (
              <Button type="submit" disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : null}
                {submitting ? t("Creating your account…") : t("Create account")}
              </Button>
            ) : null}
          </form>
        )}
      </div>
    </StandalonePage>
  );
}
