import { useTranslation } from "../../i18n";
// baskule: a password reset link from an admin (`/reset-password#token=…`). Using it signs the
// person out on every device, then they sign in with the new password.
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { StandalonePage } from "../../components/ui/standalone-page";
import { baskuleApi } from "../api";
import { errorText, FormField, BaskuleWordmark } from "../ui";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./InvitationView";

export function ResetPasswordView({ token }: { readonly token: string | null }) {
  const t = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    token === null ? "This link has no reset token in it. Copy the whole link." : null,
  );
  const [done, setDone] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const problem = passwordProblem(password, confirmation);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowProblems(true);
    if (!token || submitting || problem !== null || password !== confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      await baskuleApi.resetPassword({ token, newPassword: password });
      setDone(true);
    } catch (cause) {
      setError(errorText(cause, "The password could not be changed. The link may have expired."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StandalonePage tone="brand">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <BaskuleWordmark className="text-base" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {done ? t("Password changed") : t("Choose a new password")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {done
              ? t("You were signed out on every device. Sign in with your new password.")
              : t("Your administrator sent you this link. It works once, for one hour.")}
          </p>
        </div>
        {done ? (
          <Button render={<a href="/login" />}>{t("Sign in")}</Button>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <FormField
              label={t("New password")}
              type="password"
              autoComplete="new-password"
              autoFocus
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
              autoComplete="new-password"
              value={confirmation}
              error={
                confirmation.length > 0 && password !== confirmation
                  ? "The passwords don't match."
                  : null
              }
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
            {error ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={submitting || !token}>
              {submitting ? <Spinner size="sm" /> : null}
              {t("Change password")}
            </Button>
          </form>
        )}
      </div>
    </StandalonePage>
  );
}
