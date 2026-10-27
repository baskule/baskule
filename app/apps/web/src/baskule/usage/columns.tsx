// baskule: the columns every usage table shares: the model, then money and tokens side by side.
import { formatUsd } from "@t3tools/shared/usageFormat";

import type { useTranslation } from "../../i18n";
import { formatTokens, modelLabel } from "./format";
import type { UsageColumn } from "./UsageTable";

type Translate = ReturnType<typeof useTranslation>;

export const amountColumns = <Row extends { costUsd: number; tokens: number }>(
  t: Translate,
): UsageColumn<Row>[] => [
  {
    id: "cost",
    label: t("Cost"),
    csvLabel: t("Cost (USD)"),
    numeric: true,
    value: (row) => row.costUsd,
    render: (row) => formatUsd(row.costUsd),
    csv: (row) => row.costUsd.toFixed(4),
  },
  {
    id: "tokens",
    label: t("Tokens"),
    numeric: true,
    value: (row) => row.tokens,
    render: (row) => formatTokens(row.tokens),
  },
];

/** The model's name with its vendor beneath; the CSV adds the provider ID. */
export const modelColumns = <Row extends { provider: string; model: string }>(
  t: Translate,
): UsageColumn<Row>[] => [
  {
    id: "model",
    label: t("Model"),
    value: (row) => modelLabel(row.provider, row.model).name,
    render: (row) => {
      const label = modelLabel(row.provider, row.model);
      return (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{label.name}</span>
          <span className="truncate text-xs text-muted-foreground">{label.vendor}</span>
        </span>
      );
    },
  },
  { id: "provider", label: t("Provider"), csvOnly: true, value: (row) => row.provider },
];
