// baskule: the dialog for one of a person's plugin accounts: name it to connect or rename it, or
// choose the account that becomes the default before the current default is disconnected.
import type { Account } from "@t3tools/contracts/baskule-plugins";
import { useId, useState } from "react";

import { useTranslation } from "../../i18n";
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
import { Label } from "../../components/ui/label";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { Spinner } from "../../components/ui/spinner";
import { FormField } from "../ui";

export type AccountDialogRequest =
  | {
      readonly type: "name";
      readonly title: string;
      readonly action: string;
      readonly label: string;
      /** The person's other account names on this server: two never match. */
      readonly taken: ReadonlyArray<string>;
      readonly submit: (label: string) => void;
    }
  | {
      readonly type: "replace";
      readonly account: Account;
      readonly others: ReadonlyArray<Account>;
      readonly submit: (newDefault: string) => void;
    };

export function AccountDialog({
  request,
  busy,
  onClose,
}: {
  readonly request: AccountDialogRequest | null;
  readonly busy: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        {request?.type === "name" ? (
          <NameForm request={request} busy={busy} onClose={onClose} />
        ) : request ? (
          <ReplacementForm request={request} busy={busy} onClose={onClose} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function NameForm({
  request,
  busy,
  onClose,
}: {
  readonly request: Extract<AccountDialogRequest, { type: "name" }>;
  readonly busy: boolean;
  readonly onClose: () => void;
}) {
  const t = useTranslation();
  const [label, setLabel] = useState(request.label);
  const name = label.trim();
  const taken = request.taken.includes(name);
  const ready = name !== "" && !taken && !/\p{Cc}/u.test(name);
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) request.submit(name);
      }}
    >
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <FormField
          label={t("Account name")}
          autoFocus
          maxLength={100}
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.currentTarget.value)}
          error={taken ? t("You already have an account with this name.") : null}
          hint={t("Choose a name you will recognize, such as Work or Second.")}
        />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={!ready || busy}>
          {busy ? <Spinner size="sm" /> : null}
          {request.action}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ReplacementForm({
  request,
  busy,
  onClose,
}: {
  readonly request: Extract<AccountDialogRequest, { type: "replace" }>;
  readonly busy: boolean;
  readonly onClose: () => void;
}) {
  const t = useTranslation();
  const labelId = useId();
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (choice && !busy) request.submit(choice);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("Disconnect {{name}}?", { name: request.account.label })}</DialogTitle>
        <DialogDescription>
          {t("It is your default account. Choose the account to use by default instead.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-1.5">
          <Label id={labelId} render={<span />}>
            {t("New default account")}
          </Label>
          <RadioGroup
            aria-labelledby={labelId}
            value={choice}
            disabled={busy}
            onValueChange={(value) => setChoice(String(value))}
          >
            <div className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
              {request.others.map((account) => (
                <label
                  key={account.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm"
                >
                  <Radio value={account.id} />
                  <span className="min-w-0 truncate">{account.label}</span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button type="submit" variant="destructive" disabled={!choice || busy}>
          {busy ? <Spinner size="sm" /> : null}
          {t("Disconnect")}
        </Button>
      </DialogFooter>
    </form>
  );
}
