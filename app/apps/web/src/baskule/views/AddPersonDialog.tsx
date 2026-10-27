import { t, useTranslation } from "../../i18n";
// baskule: admin adds a person, with a temporary password or an invitation link to share.
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { type OrgRole, baskuleApi } from "../api";
import { errorText, FormField, generateTemporaryPassword } from "../ui";
import { useBaskuleMe } from "../session";

const ROLE_LABELS: Record<OrgRole, string> = {
  get member() {
    return t("Member");
  },
  get admin() {
    return t("Admin");
  },
};

export function absoluteInvitationUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

export function CopyField({ label, value }: { readonly label: string; readonly value: string }) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input nativeInput readOnly value={value} font="mono" aria-label={label} />
        <Button
          variant="outline"
          size="icon"
          aria-label={t("Copy {{value1}}", { value1: label.toLowerCase() })}
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

export function AddPersonDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdded: () => void;
}) {
  const me = useBaskuleMe();
  const t = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [mode, setMode] = useState<"password" | "invitation">("invitation");
  const [password, setPassword] = useState(() => generateTemporaryPassword());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<
    | {
        readonly mode: "password";
        readonly name: string;
        readonly email: string;
        readonly password: string;
      }
    | { readonly mode: "invitation"; readonly email: string; readonly url: string }
    | null
  >(null);

  const reset = () => {
    setName("");
    setEmail("");
    setRole("member");
    setMode("invitation");
    setPassword(generateTemporaryPassword());
    setError(null);
    setCreated(null);
    setSubmitting(false);
  };

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit =
    emailValid && (mode === "invitation" || (name.trim().length > 0 && password.length >= 8));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "password") {
        const person = await baskuleApi.createPerson({
          name: name.trim(),
          email: email.trim(),
          role,
          temporaryPassword: password,
        });
        setCreated({ mode, name: person.name, email: person.email, password });
      } else {
        const invitation = await baskuleApi.invite({ email: email.trim(), role });
        setCreated({ mode, email: email.trim(), url: absoluteInvitationUrl(invitation.url) });
      }
      onAdded();
    } catch (cause) {
      setError(errorText(cause, "The person could not be added."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) window.setTimeout(reset, 200);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {created.mode === "password"
                  ? t("{{name}} was added", { name: created.name })
                  : t("Invitation ready")}
              </DialogTitle>
              <DialogDescription>
                {created.mode === "password"
                  ? t(
                      "Share these sign-in details privately. They can change the password from their account menu.",
                    )
                  : t(
                      "Send this link to {{email}} privately. It works once and lets them choose their name and password.",
                      { email: created.email },
                    )}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {created.mode === "password" ? (
                <>
                  <CopyField label={t("Email")} value={created.email} />
                  <CopyField label={t("Temporary password")} value={created.password} />
                </>
              ) : (
                <CopyField label={t("Invitation link")} value={created.url} />
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                {t("Add another")}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t("Done")}</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate className="contents">
            <DialogHeader>
              <DialogTitle>{t("Add a person")}</DialogTitle>
              <DialogDescription>
                {t("They get a personal space. Add them to team spaces afterwards.")}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-1.5">
                <Label>{t("How they get in")}</Label>
                <ToggleGroup
                  aria-label={t("How they get in")}
                  value={[mode]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "password" || next === "invitation") setMode(next);
                  }}
                >
                  <Toggle value="invitation">{t("Invitation link")}</Toggle>
                  {me?.authentication.password ? (
                    <Toggle value="password">{t("Temporary password")}</Toggle>
                  ) : null}
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  {mode === "invitation"
                    ? t("They open the link, choose their name and sign-in method, and join the organization.")
                    : t("You create the account now and give them the password.")}
                </p>
              </div>
              {mode === "password" ? (
                <FormField
                  label={t("Name")}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              ) : null}
              <FormField
                label={t("Email")}
                type="email"
                autoComplete="off"
                autoFocus
                value={email}
                error={email.length > 0 && !emailValid ? "Enter a valid email address." : null}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
              <div className="flex flex-col gap-1.5">
                <Label>{t("Role")}</Label>
                <Select value={role} onValueChange={(value) => setRole(value as OrgRole)}>
                  <SelectTrigger aria-label={t("Role")}>
                    <SelectValue>{(value: OrgRole) => ROLE_LABELS[value]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="member">{t("Member")}</SelectItem>
                    <SelectItem value="admin">{t("Admin: manages people and spaces")}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              {mode === "password" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="baskule-temporary-password">{t("Temporary password")}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="baskule-temporary-password"
                      nativeInput
                      font="mono"
                      value={password}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t("Generate another password")}
                      onClick={() => setPassword(generateTemporaryPassword())}
                    >
                      <RefreshCwIcon />
                    </Button>
                  </div>
                </div>
              ) : null}
              {error ? (
                <Alert variant="error" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={!canSubmit || submitting}>
                {submitting ? <Spinner size="sm" /> : null}
                {mode === "invitation" ? t("Create invitation") : t("Add person")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
