import { useTranslation } from "../../../i18n";
// baskule: AI → Voice input: whether people can dictate messages, and the speech-to-text model.
import { useId, useState, type FormEvent } from "react";
import {
  BASKULE_TRANSCRIPTION_PROVIDERS,
  type BaskuleTranscriptionProviderId,
} from "@t3tools/contracts/baskule";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { BaskuleApiError, baskuleApi, type BaskuleAdminSettings } from "../../api";
import { refreshBaskuleMe } from "../../session";
import { errorText, FormField, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { saveSettingsPart } from "../settings";

export function VoiceInputPage() {
  const resource = useApiResource(baskuleApi.adminSettings);
  if (!resource.data) return <PageMessage>{resource.error ?? <Spinner />}</PageMessage>;
  return <VoiceInputForm initial={resource.data} />;
}

function VoiceInputForm({ initial }: { readonly initial: BaskuleAdminSettings }) {
  const t = useTranslation();
  const modelListId = useId();
  const [draft, setDraft] = useState(initial.transcription);
  const [saved, setSaved] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = BASKULE_TRANSCRIPTION_PROVIDERS[draft.providerId];
  // The front keeps one key per provider and endpoint, so a matching chat connection lends its key.
  const sharesChatKey =
    saved.ai.providerId === draft.providerId && saved.ai.baseUrl === draft.baseUrl;
  const keyConfigured =
    (saved.transcriptionApiKeyConfigured &&
      saved.transcription.providerId === draft.providerId &&
      saved.transcription.baseUrl === draft.baseUrl) ||
    (sharesChatKey && saved.apiKeyConfigured);

  const editConnection = (update: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...update }));
    setApiKey("");
    setClearKey(false);
    setError(null);
  };
  const selectProvider = (providerId: BaskuleTranscriptionProviderId) => {
    const selected = BASKULE_TRANSCRIPTION_PROVIDERS[providerId];
    editConnection({
      providerId,
      baseUrl: selected.baseUrl,
      model: selected.models[0]?.id ?? "",
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    return (async () => {
      const next = await saveSettingsPart({
        transcription: draft,
        ...(clearKey ? { transcriptionApiKey: "" } : apiKey ? { transcriptionApiKey: apiKey } : {}),
      });
      setSaved(next);
      setDraft(next.transcription);
      setApiKey("");
      setClearKey(false);
      await refreshBaskuleMe();
      notifySuccess(t("Voice input settings saved"));
      if (next.reloadPending)
        setError(
          t(
            "Settings are saved, but some spaces could not reload. Stop them from Admin → General → Overview to apply the AI changes.",
          ),
        );
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t("Could not save settings.")));
        // Chat moved onto this connection after the page loaded: show its key as shared from now on.
        if (cause instanceof BaskuleApiError && cause.code === "shared_api_key") {
          setClearKey(false);
          void baskuleApi.adminSettings().then(setSaved, () => undefined);
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} className="contents">
        <PageSection title={t("Dictation")}>
          <PageRow
            trailing={
              <Switch
                aria-label={t("Voice input")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            }
          >
            <span className="text-sm text-foreground">{t("Dictate messages")}</span>
            <span className="text-xs text-muted-foreground">
              {!draft.enabled
                ? t("Off: the message box has no microphone button.")
                : keyConfigured
                  ? t(
                      "On: a microphone button next to Send records a message and types it into the message box.",
                    )
                  : t("On, but nobody can use it until an API key is saved for this connection.")}
            </span>
          </PageRow>
        </PageSection>
        <PageSection title={t("Speech-to-text provider")}>
          <div
            role="radiogroup"
            aria-label={t("Speech-to-text provider")}
            className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4"
          >
            {(Object.keys(BASKULE_TRANSCRIPTION_PROVIDERS) as BaskuleTranscriptionProviderId[]).map(
              (id) => {
                const selected = draft.providerId === id;
                return (
                  <label
                    key={id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring ${
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:bg-accent/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name="transcriptionProvider"
                      value={id}
                      checked={selected}
                      onChange={() => selectProvider(id)}
                      className="accent-primary"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">
                        {BASKULE_TRANSCRIPTION_PROVIDERS[id].name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {selected ? t("Selected") : t("Off")}
                      </span>
                    </span>
                  </label>
                );
              },
            )}
          </div>
          <div className="p-4">
            <div className="grid max-w-xl gap-5">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{provider.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {draft.providerId === "custom"
                    ? t(
                        "Connect an OpenAI-compatible audio transcription API (/audio/transcriptions).",
                      )
                    : t("Use your OpenAI API key and choose a transcription model below.")}
                </p>
              </div>
              <FormField
                label={t("API key")}
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.currentTarget.value);
                  setClearKey(false);
                }}
                placeholder={
                  keyConfigured
                    ? t("Saved key. Leave blank to keep.")
                    : t("Enter a key if your endpoint requires one")
                }
                hint={
                  sharesChatKey
                    ? t(
                        "The chat model on AI → Models uses this connection too, so they share one key. A key saved here also replaces the chat key.",
                      )
                    : keyConfigured
                      ? undefined
                      : t(
                          "Each provider and endpoint has its own key. Leave blank to use a key previously saved for this connection.",
                        )
                }
              />
              {keyConfigured && !sharesChatKey ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={clearKey}
                    onChange={(e) => {
                      setClearKey(e.currentTarget.checked);
                      setApiKey("");
                    }}
                  />
                  {t("Remove the saved key")}
                </label>
              ) : null}
              <FormField
                label={t("API endpoint")}
                type="url"
                value={draft.baseUrl}
                onChange={(e) => editConnection({ baseUrl: e.currentTarget.value })}
                required
                placeholder="https://example.com/v1"
              />
              <FormField
                label={t("Model ID")}
                value={draft.model}
                list={modelListId}
                required
                maxLength={200}
                placeholder={
                  draft.providerId === "custom" ? t("Enter a model ID") : provider.models[0]?.id
                }
                hint={t(
                  "Choose a suggested model or type any model ID supported by this endpoint.",
                )}
                onChange={(e) => {
                  const model = e.currentTarget.value;
                  setDraft((current) => ({ ...current, model }));
                }}
              />
              <datalist id={modelListId}>
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
        </PageSection>
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-start gap-2 px-3 sm:px-4">
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner size="sm" /> : null}
            {t("Save settings")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("People see the change within a minute, or when they come back to the app.")}
          </p>
        </div>
      </fieldset>
    </form>
  );
}
