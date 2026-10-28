// baskule: the model's prices, which turn tokens into the costs people see and cost limits count.
// "Use suggested prices" asks the ControlCell (models.dev, or its built-in snapshot).
import type { BaskuleAIModel, BaskuleAIProviderId } from "@t3tools/contracts/baskule";
import { useState } from "react";

import { useLocale, useTranslation } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { BaskuleApiError } from "../../api";
import { errorText, FormField } from "../../ui";
import { usageApi } from "../../usage/api";

export interface PriceDraft {
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
}

const text = (value: number | undefined) => (value === undefined ? "" : String(value));

export function priceDraftOf(cost: BaskuleAIModel["cost"]): PriceDraft {
  return {
    input: text(cost?.input),
    output: text(cost?.output),
    cacheRead: text(cost?.cache_read),
    cacheWrite: text(cost?.cache_write),
  };
}

/** The model's `cost`, absent when no price is entered; null when the entry is incomplete. */
export function costOf(draft: PriceDraft): BaskuleAIModel["cost"] | null {
  const read = (value: string) => {
    if (value.trim() === "") return undefined;
    const number = Number(value.replace(",", "."));
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const values = [draft.input, draft.output, draft.cacheRead, draft.cacheWrite].map(read);
  if (values.includes(null)) return null;
  const [input, output, cacheRead, cacheWrite] = values as (number | undefined)[];
  // Input and output are both needed; cache prices fall back to the input price.
  if (input === undefined || output === undefined)
    return values.every((entry) => entry === undefined) ? undefined : null;
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
}

export function ModelPrices({
  providerId,
  modelId,
  value,
  onChange,
}: {
  readonly providerId: BaskuleAIProviderId;
  readonly modelId: string;
  readonly value: PriceDraft;
  readonly onChange: (value: PriceDraft) => void;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const field = (key: keyof PriceDraft) => ({
    type: "number",
    min: 0,
    step: "any",
    inputMode: "decimal" as const,
    value: value[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setNote(null);
      onChange({ ...value, [key]: event.currentTarget.value });
    },
  });

  const suggest = async () => {
    setBusy(true);
    setNote(null);
    return (async () => {
      const suggestion = await usageApi.prices(providerId, modelId.trim());
      onChange({
        input: text(suggestion.prices.input),
        output: text(suggestion.prices.output),
        cacheRead: text(suggestion.prices.cacheRead),
        cacheWrite: text(suggestion.prices.cacheWrite),
      });
      const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        Date.parse(suggestion.fetchedAt),
      );
      setNote(
        suggestion.source === "models.dev"
          ? t("Prices from models.dev, {{date}}. Check them against your contract.", { date })
          : t("Prices from the built-in list of {{date}}: models.dev could not be reached.", {
              date,
            }),
      );
    })()
      .catch((cause: unknown) => {
        setNote(
          cause instanceof BaskuleApiError && cause.code === "model_price_not_found"
            ? t(
                "No suggested price for this model. Enter the prices from your provider's price list.",
              )
            : errorText(cause, t("Could not get suggested prices.")),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{t("Prices")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "USD per million tokens. They estimate costs and cost limits; without them, usage counts tokens only.",
            )}
          </p>
        </div>
        {/* Custom has no catalog; OpenCode's free preset already costs nothing. */}
        {providerId === "custom" || providerId === "opencode" ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || modelId.trim() === ""}
            onClick={() => void suggest()}
          >
            {busy ? <Spinner size="sm" /> : null}
            {t("Use suggested prices")}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <FormField label={t("Input")} {...field("input")} />
        <FormField label={t("Output")} {...field("output")} />
        <FormField
          label={t("Cache read")}
          placeholder={t("Same as input")}
          {...field("cacheRead")}
        />
        <FormField
          label={t("Cache write")}
          placeholder={t("Same as input")}
          {...field("cacheWrite")}
        />
      </div>
      {note ? (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}
