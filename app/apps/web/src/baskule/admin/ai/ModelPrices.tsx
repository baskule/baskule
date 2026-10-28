// baskule: the model's prices, which turn tokens into the costs people see and cost limits count.
// Built-in providers' prices come from Baskule's catalog and are read-only; custom endpoints enter theirs.
import type { BaskuleAIModel } from "@t3tools/contracts/baskule";

import { msg, useLocale, useTranslation } from "../../../i18n";
import { Input } from "../../../components/ui/input";

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

const PRICE_FIELDS = [
  { key: "input", label: msg("Input") },
  { key: "output", label: msg("Output") },
  { key: "cacheRead", label: msg("Cache read") },
  { key: "cacheWrite", label: msg("Cache write") },
] as const;

/** Read-only prices of a built-in model. */
export function PriceSummary({ cost }: { readonly cost: BaskuleAIModel["cost"] }) {
  const t = useTranslation();
  const locale = useLocale();
  if (!cost) return <p className="text-sm text-muted-foreground">{t("Unknown")}</p>;
  const values = [cost.input, cost.output, cost.cache_read, cost.cache_write];
  if (values.every((value) => !value))
    return <p className="text-sm text-foreground">{t("Free")}</p>;
  const usd = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-sm">
      {PRICE_FIELDS.map(({ label }, index) =>
        values[index] === undefined ? null : (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="text-end text-foreground tabular-nums">{usd.format(values[index])}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

/** Every price a custom endpoint's model can have, in USD per million tokens. */
export function CustomPriceFields({
  value,
  onChange,
}: {
  readonly value: PriceDraft;
  readonly onChange: (value: PriceDraft) => void;
}) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {PRICE_FIELDS.map(({ key, label }) => (
        <label key={key} className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
          {t(label)}
          <Input
            nativeInput
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={value[key]}
            placeholder={key === "cacheRead" || key === "cacheWrite" ? t("Same as input") : "0.00"}
            onChange={(event) => onChange({ ...value, [key]: event.currentTarget.value })}
          />
        </label>
      ))}
    </div>
  );
}
