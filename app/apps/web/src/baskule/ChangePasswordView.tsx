import { useTranslation } from "../i18n";
// baskule: change your own password (Better Auth /auth/change-password). Other devices are
// signed out, as after a temporary password is replaced.
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { BaskuleApiError, baskuleApi } from "./api";
import { errorText, FormField, notifySuccess } from "./ui";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./views/InvitationView";

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(next, confirmation);

  const close = () => {
    onOpenChange(false);
    window.setTimeout(() => {
      setCurrent("");
      setNext("");
      setConfirmation("");
      setError(null);
    }, 200);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !current || problem !== null || next !== confirmation) return;
    setSubmitting(true);
    setError(null);
    return (async () => {
      await baskuleApi.changePassword({ currentPassword: current, newPassword: next });
      notifySuccess(t("Password changed"), t("Your other devices were signed out."));
      close();
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

  return (
    <Dialog open={open} onOpenChange={(value) => (value ? onOpenChange(true) : close())}>
      <DialogPopup className="sm:max-w-md">
        <form className="contents" onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>{t("Change password")}</DialogTitle>
            <DialogDescription>{t("Your other devices will be signed out.")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FormField
              label={t("Current password")}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={current}
              onChange={(event) => setCurrent(event.currentTarget.value)}
            />
            <FormField
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
              label={t("Confirm new password")}
              type="password"
              autoComplete="new-password"
              value={confirmation}
              error={
                confirmation.length > 0 && next !== confirmation
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
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !current || problem !== null}>
              {submitting ? <Spinner size="sm" /> : null}
              {t("Change password")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
