import { useTranslation } from "../../../i18n";
// baskule: AI → Models: the provider, its key and the one model everyone uses. Saving needs a passed
// connection check for the current provider, endpoint, key and model; the ControlCell checks again.
import { CheckCircle2Icon, CheckIcon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  BASKULE_AI_PROVIDERS,
  type BaskuleAIConnectionCheck,
  type BaskuleAIModel,
  type BaskuleAIProviderId,
  type BaskuleAvailableModel,
} from "@t3tools/contracts/baskule";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../../../components/ui/combobox";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { BaskuleApiError, baskuleApi, type BaskuleAdminSettings } from "../../api";
import { errorText, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageSection } from "../../views/BaskulePage";
import { saveSettingsPart } from "../settings";
import { costOf, CustomPriceFields, PriceSummary, priceDraftOf } from "./ModelPrices";
import {
  connectionCheckOf,
  connectionOf,
  defaultModel,
  limitsAreValid,
  modelFromListing,
  SAVED_KEY_MASK,
  typedKey,
} from "./modelsForm";

const PROVIDER_IDS = Object.keys(BASKULE_AI_PROVIDERS) as BaskuleAIProviderId[];
/** Typing pauses this long before the connection is checked. */
const CHECK_DELAY_MS = 600;

export function ModelsPage() {
  const resource = useApiResource(baskuleApi.adminSettings);
  if (!resource.data) return <PageMessage>{resource.error ?? <Spinner />}</PageMessage>;
  return <ModelsForm initial={resource.data} />;
}

type Check =
  | { readonly id: string; readonly status: "checking" }
  | { readonly id: string; readonly status: "valid" }
  | {
      readonly id: string;
      readonly status: "error";
      readonly message: string;
      /** The ControlCell's reason, which names the field to fix. */
      readonly code: string | null;
    };

/** Compared without the price: built-in prices follow the model and the ControlCell sets them. */
const connectionAndModel = (ai: BaskuleAdminSettings["ai"]) =>
  JSON.stringify({ ...ai, model: { ...ai.model, cost: undefined } });

function ModelsForm({ initial }: { readonly initial: BaskuleAdminSettings }) {
  const t = useTranslation();
  const [saved, setSaved] = useState(initial);
  // A saved-key listing has no key in its identity: a new key must drop it.
  const [keyRevision, setKeyRevision] = useState(0);
  const [ai, setAI] = useState(initial.ai);
  /** Null until the admin types: requests then use the key saved for the connection. */
  const [key, setKey] = useState<string | null>(null);
  const [prices, setPrices] = useState(() => priceDraftOf(initial.ai.model.cost));
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = BASKULE_AI_PROVIDERS[ai.providerId];
  const custom = ai.providerId === "custom";
  const keySavedHere =
    !provider.keyless &&
    saved.apiKeyConfigured &&
    saved.ai.providerId === ai.providerId &&
    saved.ai.baseUrl === ai.baseUrl;
  const keyMasked = key === null && keySavedHere;
  const customCost = custom ? costOf(prices) : undefined;
  const dirty =
    key !== null ||
    connectionAndModel(ai) !== connectionAndModel(saved.ai) ||
    (custom && JSON.stringify(customCost) !== JSON.stringify(saved.ai.model.cost));
  const problem = !ai.model.name.trim()
    ? "name"
    : !limitsAreValid(ai.model.limit)
      ? "limits"
      : customCost === null
        ? "prices"
        : null;

  const checkInput = connectionCheckOf(ai.providerId, ai.baseUrl, key, ai.model.id);
  const checkId = checkInput ? JSON.stringify(checkInput) : null;
  const currentCheck = check !== null && check.id === checkId ? check : null;
  const checkDue = dirty && checkId !== null && currentCheck === null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the provider once typing pauses
  useEffect(() => {
    if (!checkDue || checkId === null) return;
    const input = JSON.parse(checkId) as BaskuleAIConnectionCheck & { readonly modelId: string };
    const settle = (next: Check) =>
      setCheck((previous) => (previous?.id === next.id ? next : previous));
    const timer = window.setTimeout(() => {
      setCheck({ id: checkId, status: "checking" });
      baskuleApi.verifyAI(input).then(
        () => settle({ id: checkId, status: "valid" }),
        (cause: unknown) =>
          settle({
            id: checkId,
            status: "error",
            message: errorText(cause, ""),
            code: cause instanceof BaskuleApiError ? cause.code : null,
          }),
      );
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [checkDue, checkId]);
  const canSave = dirty && problem === null && currentCheck?.status === "valid";
  const failed = currentCheck?.status === "error" ? currentCheck.code : null;

  const updateModel = (update: Partial<BaskuleAIModel>) =>
    setAI((current) => ({ ...current, model: { ...current.model, ...update } }));
  const selectProvider = (providerId: BaskuleAIProviderId) => {
    // Coming back to the saved provider brings back its saved model.
    const next =
      providerId === saved.ai.providerId
        ? saved.ai
        : {
            providerId,
            baseUrl: BASKULE_AI_PROVIDERS[providerId].baseUrl,
            model: defaultModel(providerId),
          };
    setAI(next);
    setPrices(priceDraftOf(providerId === "custom" ? next.model.cost : undefined));
    setKey(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    return (async () => {
      // Built-in prices are the ControlCell's to set.
      const { cost: _cost, ...model } = ai.model;
      const next = await saveSettingsPart({
        ai: { ...ai, model: customCost ? { ...model, cost: customCost } : model },
        ...(key === null || provider.keyless ? {} : { apiKey: key }),
      });
      setSaved(next);
      setAI(next.ai);
      setPrices(priceDraftOf(next.ai.model.cost));
      if (key !== null) {
        listings.clear();
        setKeyRevision((revision) => revision + 1);
      }
      setKey(null);
      notifySuccess(t("AI settings saved"));
      if (next.reloadPending)
        setError(
          t(
            "Settings are saved, but some spaces could not reload. Stop them from Admin → General → Overview to apply the AI changes.",
          ),
        );
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
        <PageSection title={t("Connection")}>
          <FieldRow
            label={t("Provider")}
            description={
              ai.providerId === "opencode" ? (
                <span className="flex items-start gap-1.5">
                  <TriangleAlertIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3 shrink-0 text-warning"
                  />
                  {t(
                    "Free model hosted by OpenCode. Prompts are sent to OpenCode's servers and may be used to improve their models; subject to OpenCode's terms.",
                  )}
                </span>
              ) : custom ? (
                t("Connect an OpenAI-compatible streaming Chat Completions API.")
              ) : (
                t("Use your provider API key and choose a model below.")
              )
            }
            renderControl={(id) => (
              <Select
                value={ai.providerId}
                onValueChange={(value) => {
                  if (value) selectProvider(value as BaskuleAIProviderId);
                }}
              >
                <SelectTrigger id={id}>
                  <SelectValue>{provider.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {PROVIDER_IDS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {BASKULE_AI_PROVIDERS[id].name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          />
          {/* A keyless preset is OpenCode's own endpoint with its public token: nothing to enter. */}
          {provider.keyless ? null : (
            <>
              <FieldRow
                label={t("API key")}
                description={
                  key === null && !keySavedHere
                    ? t(
                        "Each provider and endpoint has its own key. Leave blank to use a key previously saved for this connection.",
                      )
                    : null
                }
                renderControl={(id) => (
                  <Input
                    id={id}
                    nativeInput
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={key ?? (keyMasked ? SAVED_KEY_MASK : "")}
                    aria-invalid={
                      failed === "ai_key_rejected" || failed === "ai_key_missing" ? true : undefined
                    }
                    placeholder={custom ? t("Optional") : undefined}
                    onFocus={(event) => {
                      if (keyMasked) event.currentTarget.select();
                    }}
                    onChange={(event) => setKey(typedKey(event.currentTarget.value, keyMasked))}
                  />
                )}
              />
              <FieldRow
                label={t("API endpoint")}
                renderControl={(id) => (
                  <Input
                    id={id}
                    nativeInput
                    type="url"
                    required
                    value={ai.baseUrl}
                    aria-invalid={failed === "ai_provider_unreachable" ? true : undefined}
                    placeholder="https://example.com/v1"
                    onChange={(event) => {
                      const baseUrl = event.currentTarget.value;
                      setAI((current) => ({ ...current, baseUrl }));
                    }}
                  />
                )}
              />
            </>
          )}
          <FieldRow
            label={t("Model")}
            renderControl={(id) =>
              custom ? (
                <Input
                  id={id}
                  nativeInput
                  required
                  maxLength={200}
                  spellCheck={false}
                  value={ai.model.id}
                  aria-invalid={failed === "ai_model_not_found" ? true : undefined}
                  placeholder={t("Enter a model ID")}
                  onChange={(event) => {
                    const modelId = event.currentTarget.value;
                    // The display name follows the ID until the admin names the model.
                    setAI((current) => ({
                      ...current,
                      model: {
                        ...current.model,
                        id: modelId,
                        name:
                          current.model.name === current.model.id ? modelId : current.model.name,
                      },
                    }));
                  }}
                />
              ) : (
                <ModelPicker
                  key={keyRevision}
                  id={id}
                  connection={connectionOf(ai.providerId, ai.baseUrl, key)}
                  keyless={provider.keyless === true}
                  invalid={failed === "ai_model_not_found"}
                  model={ai.model}
                  onPick={(listed) =>
                    setAI((current) => ({ ...current, model: modelFromListing(listed) }))
                  }
                />
              )
            }
          />
          {dirty ? (
            <ConnectionStatus
              check={
                checkId === null ? null : (currentCheck ?? { id: checkId, status: "checking" })
              }
              onRetry={() => setCheck(null)}
            />
          ) : null}
        </PageSection>
        <PageSection title={t("Model details")}>
          {custom ? null : (
            <FieldRow
              label={t("Price")}
              description={t(
                "USD per million tokens. They estimate costs and cost limits; without them, usage counts tokens only.",
              )}
              renderControl={() => <PriceSummary cost={ai.model.cost} />}
            />
          )}
          <FieldRow
            label={t("Display name")}
            error={problem === "name" ? t("Enter a display name.") : null}
            renderControl={(id) => (
              <Input
                id={id}
                nativeInput
                required
                maxLength={100}
                value={ai.model.name}
                onChange={(event) => updateModel({ name: event.currentTarget.value })}
              />
            )}
          />
          <FieldRow
            label={t("Context window (tokens)")}
            renderControl={(id) => (
              <TokenInput
                id={id}
                value={ai.model.limit.context}
                onChange={(context) => updateModel({ limit: { ...ai.model.limit, context } })}
              />
            )}
          />
          <FieldRow
            label={t("Maximum output (tokens)")}
            error={
              problem === "limits"
                ? t(
                    "Use whole numbers: a context window of at least 1,024 tokens and a smaller maximum output.",
                  )
                : null
            }
            renderControl={(id) => (
              <TokenInput
                id={id}
                value={ai.model.limit.output}
                onChange={(output) => updateModel({ limit: { ...ai.model.limit, output } })}
              />
            )}
          />
          <FieldRow
            label={t("Images")}
            description={t("Send images people attach to the model.")}
            renderControl={(id) => (
              <Switch
                id={id}
                checked={ai.model.image}
                onCheckedChange={(image) => updateModel({ image })}
              />
            )}
          />
          <FieldRow
            label={t("PDFs")}
            description={t("Send PDFs people attach to the model.")}
            renderControl={(id) => (
              <Switch
                id={id}
                checked={ai.model.pdf}
                onCheckedChange={(pdf) => updateModel({ pdf })}
              />
            )}
          />
        </PageSection>
        {custom ? (
          <PageSection
            title={t("Prices")}
            description={t(
              "USD per million tokens. They estimate costs and cost limits; without them, usage counts tokens only.",
            )}
          >
            <div className="flex flex-col gap-2 px-3 py-3 sm:px-4">
              <CustomPriceFields value={prices} onChange={setPrices} />
              {problem === "prices" ? (
                <p className="text-xs text-destructive-foreground">
                  {t(
                    "Enter both the input and output prices as numbers, or leave all prices empty.",
                  )}
                </p>
              ) : null}
            </div>
          </PageSection>
        ) : null}
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-start gap-2 px-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button type="submit" disabled={!canSave || busy}>
              {busy ? <Spinner size="sm" /> : null}
              {t("Save settings")}
            </Button>
            {dirty && !canSave && !busy ? (
              <span className="text-xs text-muted-foreground">
                {t("You can save once the connection works and every field is valid.")}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("AI changes reload spaces after answers in progress finish.")}
          </p>
        </div>
      </fieldset>
    </form>
  );
}

/** A settings row: what it is on the left, its control on the right; stacked when narrow. */
function FieldRow({
  label,
  description,
  error,
  renderControl,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: string | null;
  readonly renderControl: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-center lg:gap-8">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id}>{label}</Label>
          {description ? (
            <p className="text-xs leading-normal text-muted-foreground">{description}</p>
          ) : null}
          {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        </div>
        <div className="flex min-w-0 items-center justify-end">{renderControl(id)}</div>
      </div>
    </div>
  );
}

function TokenInput({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Input
      id={id}
      nativeInput
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      required
      value={value > 0 ? String(value) : ""}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}

function ConnectionStatus({
  check,
  onRetry,
}: {
  readonly check: Check | null;
  readonly onRetry: () => void;
}) {
  const t = useTranslation();
  return (
    <div
      role="status"
      className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2.5 text-sm sm:px-4"
    >
      {check === null ? (
        <span className="text-muted-foreground">
          {t("Choose a model and an API endpoint to check the connection.")}
        </span>
      ) : check.status === "checking" ? (
        <>
          <Spinner size="sm" tone="muted" />
          <span className="text-muted-foreground">{t("Checking the connection…")}</span>
        </>
      ) : check.status === "valid" ? (
        <>
          <CheckCircle2Icon aria-hidden className="size-4 shrink-0 text-success" />
          <span className="text-foreground">{t("Connection works")}</span>
        </>
      ) : (
        <>
          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
          <span className="text-destructive-foreground">
            {check.message || t("Could not check the connection.")}
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
            {t("Check again")}
          </Button>
        </>
      )}
    </div>
  );
}

type Listing =
  | { readonly id: string; readonly status: "loading" }
  | { readonly id: string; readonly status: "ready"; readonly models: BaskuleAvailableModel[] }
  | { readonly id: string; readonly status: "error"; readonly message: string };

/** Model lists per provider, endpoint and key, kept for the session: listing can take seconds. */
const listings = new Map<string, Promise<BaskuleAvailableModel[]>>();
function listModels(connection: BaskuleAIConnectionCheck): Promise<BaskuleAvailableModel[]> {
  const id = JSON.stringify(connection);
  const cached = listings.get(id);
  if (cached) return cached;
  const pending = baskuleApi.aiModels(connection);
  listings.set(id, pending);
  pending.catch(() => listings.delete(id));
  return pending;
}

/** The provider's models for this key, loaded when the picker first opens. */
function ModelPicker({
  id,
  connection,
  keyless,
  invalid,
  model,
  onPick,
}: {
  readonly id: string;
  readonly connection: BaskuleAIConnectionCheck;
  readonly keyless: boolean;
  readonly invalid: boolean;
  readonly model: BaskuleAIModel;
  readonly onPick: (model: BaskuleAvailableModel) => void;
}) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const listId = JSON.stringify(connection);
  const shown = listing?.id === listId ? listing : null;
  // OpenCode's public token reaches only its free presets: there is nothing to list.
  const models: BaskuleAvailableModel[] = keyless
    ? BASKULE_AI_PROVIDERS[connection.providerId].models
    : shown?.status === "ready"
      ? shown.models
      : [];
  const search = query.trim().toLowerCase();
  const matches = models.filter(
    (entry) =>
      !search ||
      entry.id.toLowerCase().includes(search) ||
      entry.name.toLowerCase().includes(search),
  );
  const ids = matches.map((entry) => entry.id);

  const load = () => {
    if (keyless || (shown !== null && shown.status !== "error")) return;
    setListing({ id: listId, status: "loading" });
    const settle = (next: Listing) =>
      setListing((previous) => (previous?.id === next.id ? next : previous));
    listModels(connection).then(
      (listed) => settle({ id: listId, status: "ready", models: listed }),
      (cause: unknown) =>
        settle({
          id: listId,
          status: "error",
          message: errorText(cause, t("Could not load the models.")),
        }),
    );
  };

  return (
    <Combobox
      items={ids}
      filteredItems={ids}
      filter={null}
      autoHighlight
      value={model.id}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setQuery("");
        load();
      }}
      onValueChange={(value) => {
        const picked = models.find((entry) => entry.id === value);
        if (picked) onPick(picked);
        setOpen(false);
      }}
    >
      <ComboboxTrigger id={id} aria-invalid={invalid || undefined} render={<SelectButton />}>
        {model.name || model.id || t("Choose a model")}
        {model.name && model.name !== model.id ? (
          <span className="ms-2 text-muted-foreground">{model.id}</span>
        ) : null}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-80">
        <ComboboxSearchInput
          aria-label={t("Search models")}
          placeholder={t("Search models")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxList className="max-h-72">
          {shown?.status === "loading" ? (
            <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <Spinner size="sm" tone="muted" />
              {t("Loading the provider's models…")}
            </p>
          ) : shown?.status === "error" ? (
            <p className="p-2 text-xs text-destructive-foreground">{shown.message}</p>
          ) : matches.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {search ? t("No model matches your search.") : t("This key has no chat models.")}
            </p>
          ) : (
            matches.map((entry, index) => (
              <ComboboxItem key={entry.id} hideIndicator index={index} value={entry.id}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{entry.name}</span>
                  {entry.name === entry.id ? null : (
                    <span className="truncate text-xs text-muted-foreground">{entry.id}</span>
                  )}
                </span>
                {entry.id === model.id ? (
                  <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
                ) : null}
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
