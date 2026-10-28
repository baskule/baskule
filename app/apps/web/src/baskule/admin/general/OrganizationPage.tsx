// baskule: General → Organization: the organization's name and the computer idle timeout.
import { useState, type FormEvent } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { baskuleApi, type BaskuleAdminSettings } from "../../api";
import { refreshBaskuleMe } from "../../session";
import { errorText, FormField, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageSection } from "../../views/BaskulePage";
import { PushSettings } from "./PushSettings";
import { saveSettingsPart } from "../settings";

export function OrganizationPage() {
  const resource = useApiResource(baskuleApi.adminSettings);
  if (!resource.data) return <PageMessage>{resource.error ?? <Spinner />}</PageMessage>;
  return (
    <>
      <OrganizationForm initial={resource.data} />
      <PushSettings />
    </>
  );
}

function OrganizationForm({ initial }: { readonly initial: BaskuleAdminSettings }) {
  const t = useTranslation();
  const [name, setName] = useState(initial.organizationName);
  const [idleMinutes, setIdleMinutes] = useState(String(initial.idleMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    return (async () => {
      const saved = await saveSettingsPart({
        organizationName: name,
        idleMinutes: Number(idleMinutes),
      });
      setName(saved.organizationName);
      setIdleMinutes(String(saved.idleMinutes));
      await refreshBaskuleMe();
      notifySuccess(t("Organization settings saved"));
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t("Could not save settings.")));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} className="contents">
        <PageSection title={t("Organization")}>
          <div className="p-4">
            <FormField
              className="max-w-md"
              label={t("Organization name")}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
              maxLength={100}
            />
          </div>
        </PageSection>
        <PageSection title={t("Computers")}>
          <div className="p-4">
            <FormField
              className="max-w-md"
              label={t("Stop idle computers after (minutes)")}
              type="number"
              min={0.1}
              step={0.1}
              max={1440}
              value={idleMinutes}
              onChange={(e) => setIdleMinutes(e.currentTarget.value)}
              hint={t(
                "Computers with active work stay running. A stopped computer starts again on the next task.",
              )}
              required
            />
          </div>
        </PageSection>
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="px-3 sm:px-4">
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner size="sm" /> : null}
            {t("Save settings")}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
