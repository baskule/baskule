import { useTranslation } from "../../i18n";

// baskule: the one-time setup link (`/setup#token=…`) creates a new installation's first administrator.
import { useEffect, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { StandalonePage } from "../../components/ui/standalone-page";
import { BaskuleApiError, SETUP_LINK_COMMAND, baskuleApi } from "../api";
import { ensureSignedInAs } from "../session";
import { errorText, FormField, BaskuleWordmark, useApiResource } from "../ui";
import { CopyField } from "./AddPersonDialog";
import { MIN_PASSWORD_LENGTH, passwordProblem, tokenFromHash } from "./InvitationView";

const MODELS_PATH = "/admin/ai/models";
const SIGN_IN_AFTER_SETUP = `/login?next=${encodeURIComponent(MODELS_PATH)}`;

const removeFragment = () =>
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );

/** The route: each link opened or pasted into the address bar starts over with its token. */
export function SetupView() {
  const [link, setLink] = useState(() => ({
    token: tokenFromHash(window.location.hash),
    arrival: 0,
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Take each setup token that arrives in the address bar, then remove it from the address bar and history.
  useEffect(() => {
    const arrive = () => {
      if (!window.location.hash) return;
      const token = tokenFromHash(window.location.hash);
      removeFragment();
      setLink((current) => ({ token, arrival: current.arrival + 1 }));
    };
    removeFragment();
    window.addEventListener("hashchange", arrive);
    return () => window.removeEventListener("hashchange", arrive);
  }, []);

  return <SetupScreen key={link.arrival} token={link.token} />;
}

function SetupScreen({ token }: { readonly token: string | null }) {
  const t = useTranslation();
  const status = useApiResource(baskuleApi.setupStatus);
  const [outcome, setOutcome] = useState<"bad_token" | "already_set_up" | "created" | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const passwordMode = status.data?.password === true;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const problem = passwordMode ? passwordProblem(password, confirmation) : null;
  const mismatch = passwordMode && password !== confirmation;
  const view =
    outcome === "already_set_up" || status.data?.required === false
      ? "already_set_up"
      : outcome === "created"
        ? "created"
        : !status.data
          ? status.error
            ? "unavailable"
            : "loading"
          : token === null || outcome === "bad_token"
            ? "bad_link"
            : "form";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowProblems(true);
    if (submitting || !token || !name.trim() || !emailValid || problem !== null || mismatch) return;
    setSubmitting(true);
    setError(null);
    const account = { name: name.trim(), email: email.trim() };
    const created = await baskuleApi
      .completeSetup({ token, ...account, ...(passwordMode ? { password } : {}) })
      .catch((cause: unknown) => {
        const refusal = cause instanceof BaskuleApiError ? cause.status : null;
        if (refusal === 403) setOutcome("bad_token");
        else if (refusal === 409) setOutcome("already_set_up");
        else if (refusal === 429) setError(t("Too many attempts. Wait a minute and try again."));
        else setError(errorText(cause, t("Setup failed. Try again.")));
        setSubmitting(false);
        return null;
      });
    if (created === null) return;
    if (!passwordMode) {
      setOutcome("created");
      return;
    }
    const signedIn = await ensureSignedInAs(created.id, { email: account.email, password });
    // A full load starts every space connection with the new session.
    window.location.assign(signedIn ? MODELS_PATH : SIGN_IN_AFTER_SETUP);
  };

  return (
    <StandalonePage>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <BaskuleWordmark className="text-base" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {view === "already_set_up"
              ? t("Already set up")
              : view === "created"
                ? t("Sign in to finish")
                : view === "bad_link"
                  ? t("Setup link unavailable")
                  : t("Set up Baskule")}
          </h1>
          {view === "already_set_up" ? (
            <p className="text-sm text-muted-foreground">
              {t(
                "This installation already has an administrator. Sign in, or ask an administrator to invite you.",
              )}
            </p>
          ) : view === "created" ? (
            <p className="text-sm text-muted-foreground">
              {t(
                "Your administrator account is ready. Sign in with your organization account as {{email}}.",
                {
                  email: email.trim(),
                },
              )}
            </p>
          ) : view === "form" ? (
            <p className="text-sm text-muted-foreground">
              {passwordMode
                ? t(
                    "Create the first administrator account. You can invite everyone else afterwards.",
                  )
                : t(
                    "Create the first administrator account, then sign in with your organization account using the same email.",
                  )}
            </p>
          ) : null}
        </div>
        {view === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            {t("Checking this installation…")}
          </p>
        ) : view === "unavailable" ? (
          <div className="flex flex-col gap-4">
            <Alert variant="error" role="alert">
              <AlertDescription>{status.error}</AlertDescription>
            </Alert>
            <Button variant="outline" onClick={() => void status.reload()}>
              {t("Try again")}
            </Button>
          </div>
        ) : view === "already_set_up" || view === "created" ? (
          <Button render={<a href={view === "created" ? SIGN_IN_AFTER_SETUP : "/login"} />}>
            {t("Sign in")}
          </Button>
        ) : view === "bad_link" ? (
          <div className="flex flex-col gap-4">
            <Alert variant="error" role="alert">
              <AlertDescription>
                {token === null
                  ? t("This link has no setup token in it. Copy the whole link.")
                  : t("This setup link is not valid. Use the latest link from the setup logs.")}
              </AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground">
              {t("On the server, run this command in the Baskule folder to print the setup link.")}
            </p>
            <CopyField label={t("Command")} value={SETUP_LINK_COMMAND} />
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <FormField
              label={t("Your name")}
              name="name"
              autoComplete="name"
              autoFocus
              required
              value={name}
              error={showProblems && !name.trim() ? t("Enter your name.") : null}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <FormField
              label={t("Email")}
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              error={showProblems && !emailValid ? t("Enter a valid email address.") : null}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            {passwordMode ? (
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
                  error={
                    (showProblems || confirmation.length > 0) && mismatch
                      ? t("The passwords don't match.")
                      : null
                  }
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                />
              </>
            ) : null}
            {error ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? <Spinner size="sm" /> : null}
              {submitting ? t("Creating your account…") : t("Create account")}
            </Button>
          </form>
        )}
      </div>
    </StandalonePage>
  );
}
