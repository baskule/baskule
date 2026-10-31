import { useLocale, useTranslation } from "../../../i18n";
// baskule: the per-person limits. Off by default; each window is optional and takes a token limit,
// a cost limit or both. Rules are kept while the master switch is off.
import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { errorText, FormField, notifySuccess, useApiResource } from "../../ui";
import {
  usageApi,
  type UsageLimitRule,
  type UsageLimitSettings,
  type UsageWindow,
} from "../../usage/api";
import { WINDOWS, formatTokens, parseTokens, windowCopy } from "../../usage/format";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";

interface WindowDraft {
  readonly on: boolean;
  readonly tokens: string;
  readonly cost: string;
}
type Draft = { readonly enabled: boolean; readonly windows: Record<UsageWindow, WindowDraft> };

/** "2M" when that is exact, the plain number otherwise, so editing never rounds a limit. */
function tokensText(tokens: number | undefined): string {
  if (tokens === undefined) return "";
  const short = formatTokens(tokens);
  return parseTokens(short) === tokens ? short : String(tokens);
}

export function draftOf(settings: UsageLimitSettings): Draft {
  const rule = (window: UsageWindow) => settings.rules.find((entry) => entry.window === window);
  const windows = Object.fromEntries(
    WINDOWS.map((window) => {
      const found = rule(window);
      return [
        window,
        {
          on: found !== undefined,
          tokens: tokensText(found?.tokens),
          cost: found?.costUsd === undefined ? "" : String(found.costUsd),
        },
      ];
    }),
  ) as Record<UsageWindow, WindowDraft>;
  return { enabled: settings.enabled, windows };
}

/** The settings to save, or the first problem in plain words. */
export function settingsOf(
  draft: Draft,
  t: ReturnType<typeof useTranslation>,
): { settings: UsageLimitSettings } | { error: string } {
  const rules: UsageLimitRule[] = [];
  for (const window of WINDOWS) {
    const entry = draft.windows[window];
    if (!entry.on) continue;
    const name = windowCopy(window).name;
    const tokens = entry.tokens.trim() === "" ? undefined : parseTokens(entry.tokens);
    if (tokens === null || (tokens !== undefined && tokens < 1))
      return {
        error: t("{{name}}: enter tokens as a whole number, such as 500k or 2M.", { name }),
      };
    const cost = entry.cost.trim() === "" ? undefined : Number(entry.cost.replace(",", "."));
    if (cost !== undefined && (!Number.isFinite(cost) || cost <= 0))
      return { error: t("{{name}}: enter a cost above zero, such as 5 or 12.50.", { name }) };
    if (tokens === undefined && cost === undefined)
      return { error: t("{{name}}: set a token limit, a cost limit, or both.", { name }) };
    rules.push({
      window,
      ...(tokens === undefined ? {} : { tokens }),
      ...(cost === undefined ? {} : { costUsd: cost }),
    });
  }
  if (draft.enabled && rules.length === 0)
    return { error: t("Turn on at least one limit below, or turn off Limit usage.") };
  return { settings: { enabled: draft.enabled, rules } };
}

export function LimitsEditor() {
  const resource = useApiResource(usageApi.limits);
  if (!resource.data) return <PageMessage>{resource.error ?? <Spinner />}</PageMessage>;
  return <LimitsForm initial={resource.data} />;
}

function LimitsForm({ initial }: { readonly initial: UsageLimitSettings }) {
  const t = useTranslation();
  const locale = useLocale();
  const [saved, setSaved] = useState(() => draftOf(initial));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const setWindow = (window: UsageWindow, update: Partial<WindowDraft>) =>
    setDraft((current) => ({
      ...current,
      windows: { ...current.windows, [window]: { ...current.windows[window], ...update } },
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = settingsOf(draft, t);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    return (async () => {
      const next = draftOf(await usageApi.setLimits(result.settings));
      setSaved(next);
      setDraft(next);
      notifySuccess(
        result.settings.enabled ? t("Limits saved and applied") : t("Limits saved, not applied"),
      );
    })()
      .catch((cause: unknown) => {
        setError(errorText(cause, t("Could not save the limits.")));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} className="contents">
        <PageSection
          title={t("Limits")}
          description={t(
            "Each person has their own limits, counted on the messages they send in any space. There are no team or space budgets.",
          )}
        >
          <PageRow
            trailing={
              <Switch
                aria-label={t("Limit usage")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            }
          >
            <span className="text-sm text-foreground">{t("Limit usage")}</span>
            <span className="text-xs text-muted-foreground">
              {draft.enabled
                ? t(
                    "On: when a person reaches a limit, their next messages wait until it resets. Answers already started finish.",
                  )
                : t("Off: nobody is limited. You can prepare limits below and turn this on later.")}
            </span>
          </PageRow>
          {WINDOWS.map((window) => {
            const entry = draft.windows[window];
            const copy = windowCopy(window);
            return (
              <div
                key={window}
                className={draft.enabled ? undefined : "opacity-70"}
                data-testid={`usage-limit-${window}`}
              >
                <PageRow
                  trailing={
                    <Switch
                      aria-label={copy.name}
                      checked={entry.on}
                      onCheckedChange={(on) => setWindow(window, { on })}
                    />
                  }
                >
                  <span className="text-sm text-foreground">{copy.name}</span>
                  <span className="text-xs text-muted-foreground">{copy.period}</span>
                </PageRow>
                {entry.on ? (
                  <div className="grid gap-4 px-3 pb-4 sm:grid-cols-2 sm:px-4">
                    <FormField
                      label={t("Tokens per person")}
                      inputMode="text"
                      autoComplete="off"
                      placeholder={t("No token limit")}
                      value={entry.tokens}
                      onChange={(event) => setWindow(window, { tokens: event.currentTarget.value })}
                      hint={(() => {
                        const tokens = parseTokens(entry.tokens);
                        return tokens === null
                          ? t("For example 500k or 2M.")
                          : t("{{tokens}} tokens", { tokens: tokens.toLocaleString(locale) });
                      })()}
                    />
                    <FormField
                      label={t("Cost per person (USD)")}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={t("No cost limit")}
                      value={entry.cost}
                      onChange={(event) => setWindow(window, { cost: event.currentTarget.value })}
                      hint={t("Estimated from the model prices on the Models page.")}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </PageSection>
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-start gap-2 px-3 sm:px-4">
          <Button type="submit" disabled={busy || !dirty}>
            {busy ? <Spinner size="sm" /> : null}
            {t("Save limits")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(
              "Days, weeks and months start at midnight UTC. Everyone sees their limits under Settings → Usage.",
            )}
          </p>
        </div>
      </fieldset>
    </form>
  );
}
