// baskule: AI → Models: the provider, its key and the one model everyone uses.
import { TriangleAlertIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import {
  BASKULE_AI_PROVIDERS,
  blankBaskuleModel,
  type BaskuleAIProviderId,
} from "@t3tools/contracts/baskule";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { baskuleApi, type BaskuleAdminSettings } from "../../api";
import { FormField, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageSection } from "../../views/BaskulePage";
import { saveSettingsPart } from "../settings";
import { costOf, ModelPrices, priceDraftOf } from "./ModelPrices";

export function ModelsPage() {
  const resource = useApiResource(baskuleApi.adminSettings);
  if (!resource.data) return <PageMessage>{resource.error ?? <Spinner />}</PageMessage>;
  return <ModelsForm initial={resource.data} />;
}

function ModelsForm({ initial }: { readonly initial: BaskuleAdminSettings }) {
  const t = useTranslation();
  const modelListId = useId();
  const [ai, setAI] = useState(initial.ai);
  const [settingsText, setSettingsText] = useState(() =>
    JSON.stringify(initial.ai.model.settings, null, 2),
  );
  const [prices, setPrices] = useState(() => priceDraftOf(initial.ai.model.cost));
  const [apiKey, setApiKey] = useState("");
  const [savedConnection, setSavedConnection] = useState(initial);
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = BASKULE_AI_PROVIDERS[ai.providerId];
  const keyConfigured =
    savedConnection.apiKeyConfigured &&
    savedConnection.ai.providerId === ai.providerId &&
    savedConnection.ai.baseUrl === ai.baseUrl;
  const updateModel = (update: Partial<typeof ai.model>) =>
    setAI((current) => ({ ...current, model: { ...current.model, ...update } }));

  const selectProvider = (providerId: BaskuleAIProviderId) => {
    const selected = BASKULE_AI_PROVIDERS[providerId];
    const model = selected.models[0] ?? blankBaskuleModel();
    setAI({ providerId, baseUrl: selected.baseUrl, model });
    setSettingsText(JSON.stringify(model.settings, null, 2));
    setPrices(priceDraftOf(model.cost));
    setApiKey("");
    setClearKey(false);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const cost = costOf(prices);
    if (cost === null) {
      setError(t("Enter both the input and output prices as numbers, or leave all prices empty."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { cost: _previous, ...model } = ai.model;
      const saved = await saveSettingsPart({
        ai: {
          ...ai,
          model: {
            ...model,
            ...(cost ? { cost } : {}),
            settings: JSON.parse(settingsText) as Record<string, unknown>,
          },
        },
        ...(clearKey ? { apiKey: "" } : apiKey ? { apiKey } : {}),
      });
      setAI(saved.ai);
      setSettingsText(JSON.stringify(saved.ai.model.settings, null, 2));
      setPrices(priceDraftOf(saved.ai.model.cost));
      setApiKey("");
      setClearKey(false);
      setSavedConnection(saved);
      notifySuccess(t("AI settings saved"));
      if (saved.reloadPending)
        setError(
          t(
            "Settings are saved, but some spaces could not reload. Stop them from Admin → General → Overview to apply the AI changes.",
          ),
        );
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? t("Advanced model settings must be valid JSON objects.")
          : cause instanceof Error
            ? cause.message
            : t("Could not save settings."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} className="contents">
        <PageSection title={t("AI provider")}>
          <div
            role="radiogroup"
            aria-label={t("AI provider")}
            className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-5"
          >
            {(Object.keys(BASKULE_AI_PROVIDERS) as BaskuleAIProviderId[]).map((id) => {
              const selected = ai.providerId === id;
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring ${
                    selected ? "border-primary bg-primary/5" : "border-border/60 hover:bg-accent/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="aiProvider"
                    value={id}
                    checked={selected}
                    onChange={() => selectProvider(id)}
                    className="accent-primary"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{BASKULE_AI_PROVIDERS[id].name}</span>
                    <span className="text-xs text-muted-foreground">
                      {selected ? t("Selected") : t("Off")}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="p-4">
            <div className="grid max-w-xl gap-5">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{provider.name}</h3>
                {ai.providerId === "opencode" ? (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <TriangleAlertIcon
                      aria-hidden="true"
                      className="mt-0.5 size-3 shrink-0 text-warning"
                    />
                    {t(
                      "Free model hosted by OpenCode. Prompts are sent to OpenCode's servers and may be used to improve their models; subject to OpenCode's terms.",
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {ai.providerId === "custom"
                      ? t("Connect an OpenAI-compatible streaming Chat Completions API.")
                      : t("Use your provider API key and choose a model below.")}
                  </p>
                )}
              </div>
              {/* A keyless preset is OpenCode's own endpoint with its public token: nothing to enter. */}
              {provider.keyless ? null : (
                <>
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
                      keyConfigured
                        ? t("A key is saved for this connection. Saved keys are never displayed.")
                        : t(
                            "Each provider and endpoint has its own key. Leave blank to use a key previously saved for this connection.",
                          )
                    }
                  />
                  {keyConfigured ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
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
                    value={ai.baseUrl}
                    onChange={(e) => {
                      const baseUrl = e.currentTarget.value;
                      setAI((current) => ({ ...current, baseUrl }));
                      setApiKey("");
                      setClearKey(false);
                    }}
                    required
                    placeholder="https://example.com/v1"
                  />
                </>
              )}
              <FormField
                label={t("Model ID")}
                value={ai.model.id}
                list={modelListId}
                required
                maxLength={200}
                placeholder={
                  ai.providerId === "custom" ? t("Enter a model ID") : provider.models[0]?.id
                }
                hint={t(
                  "Choose a suggested model or type any model ID supported by this endpoint.",
                )}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  const preset = provider.models.find((m) => m.id === id);
                  const model = preset ?? { ...blankBaskuleModel(), id, name: id };
                  setAI((current) => ({ ...current, model }));
                  setSettingsText(JSON.stringify(model.settings, null, 2));
                  // A preset brings its prices; a typed ID keeps what is entered.
                  if (preset) setPrices(priceDraftOf(preset.cost));
                }}
              />
              <datalist id={modelListId}>
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
              <ModelPrices
                providerId={ai.providerId}
                modelId={ai.model.id}
                value={prices}
                onChange={setPrices}
              />
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  {t("Advanced model settings")}
                </summary>
                <div className="mt-4 grid gap-4">
                  <FormField
                    label={t("Display name")}
                    value={ai.model.name}
                    required
                    maxLength={100}
                    onChange={(e) => updateModel({ name: e.currentTarget.value })}
                  />
                  <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={ai.model.image}
                        onChange={(e) => updateModel({ image: e.currentTarget.checked })}
                      />
                      {t("Images")}
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={ai.model.pdf}
                        onChange={(e) => updateModel({ pdf: e.currentTarget.checked })}
                      />
                      {t("PDFs")}
                    </label>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      label={t("Context window (tokens)")}
                      type="number"
                      min={1024}
                      max={10_000_000}
                      value={String(ai.model.limit.context)}
                      required
                      onChange={(e) =>
                        updateModel({
                          limit: { ...ai.model.limit, context: Number(e.currentTarget.value) },
                        })
                      }
                    />
                    <FormField
                      label={t("Maximum output (tokens)")}
                      type="number"
                      min={1}
                      max={1_000_000}
                      value={String(ai.model.limit.output)}
                      required
                      onChange={(e) =>
                        updateModel({
                          limit: { ...ai.model.limit, output: Number(e.currentTarget.value) },
                        })
                      }
                    />
                  </div>
                  <Label className="flex flex-col">
                    {t("Settings (JSON)")}
                    <Textarea
                      rows={4}
                      value={settingsText}
                      onChange={(e) => setSettingsText(e.currentTarget.value)}
                    />
                  </Label>
                </div>
              </details>
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
            {t("AI changes reload spaces after answers in progress finish.")}
          </p>
        </div>
      </fieldset>
    </form>
  );
}
