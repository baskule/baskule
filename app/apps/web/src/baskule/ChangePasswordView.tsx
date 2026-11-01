import { useTranslation } from "../i18n";

// baskule: Settings → Change password (Better Auth /auth/change-password). Other devices are
// signed out, as after a temporary password is replaced.
import { useState, type FormEvent } from "react";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { BaskuleApiError, baskuleApi } from "./api";
import { useBaskuleMe } from "./session";
import { errorText, FormField, notifySuccess } from "./ui";
import { PageMessage, PageSection } from "./views/BaskulePage";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./views/InvitationView";

export function ChangePasswordView() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(next, confirmation);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !current || problem !== null || next !== confirmation) return;
    setSubmitting(true);
    setError(null);
    return (async () => {
      await baskuleApi.changePassword({ currentPassword: current, newPassword: next });
      notifySuccess(t("Password changed"), t("Your other devices were signed out."));
      setCurrent("");
      setNext("");
      setConfirmation("");
    })()
      .catch((cause: unknown) => {
        setError(
          cause instanceof BaskuleApiError && (cause.status === 400 || cause.status === 401)
            ? t("The current password is not right.")
            : errorText(cause),
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  if (me !== null && !me.authentication.password) {
    return (
      <SettingsPageContainer>
        <PageSection title={t("Password")}>
          <PageMessage>{t("Password sign-in is unavailable on this server.")}</PageMessage>
        </PageSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset disabled={submitting} className="contents">
          <PageSection title={t("Password")}>
            <div className="flex flex-col gap-4 p-4">
              <FormField
                className="max-w-md"
                label={t("Current password")}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.currentTarget.value)}
              />
              <FormField
                className="max-w-md"
                label={t("New password")}
                type="password"
                autoComplete="new-password"
                hint={t("At least {{MIN_PASSWORD_LENGTH}} characters.", {
                  MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
                })}
                value={next}
                onChange={(event) => setNext(event.currentTarget.value)}
              />
              <FormField
                className="max-w-md"
                label={t("Confirm new password")}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                error={
                  confirmation.length > 0 && next !== confirmation
                    ? t("The passwords don't match.")
                    : null
                }
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </div>
          </PageSection>
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="px-3 sm:px-4">
            <Button type="submit" disabled={submitting || !current || problem !== null}>
              {submitting ? <Spinner size="sm" /> : null}
              {t("Change password")}
            </Button>
          </div>
        </fieldset>
      </form>
    </SettingsPageContainer>
  );
}
