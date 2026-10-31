import { useLocale, useTranslation } from "../../../i18n";
// baskule: AI → Usage & limits, the organization's usage: totals, a daily chart and who, which
// model and which space it went to. Each table sorts and exports what it shows.
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";
import { DownloadIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { cn } from "../../../lib/utils";
import { baskuleApi, type AdminSpace } from "../../api";
import { useApiResource } from "../../ui";
import { usageApi, type AdminUsage } from "../../usage/api";
import { amountColumns, modelColumns } from "../../usage/columns";
import { formatTokens, periodRange, type UsagePeriod } from "../../usage/format";
import { UsageDailyChart } from "../../usage/UsageDailyChart";
import {
  UsageTable,
  sortRows,
  usageCsv,
  type UsageColumn,
  type UsageSort,
} from "../../usage/UsageTable";
import { PageMessage, PageSection } from "../../views/BaskulePage";

type Translate = ReturnType<typeof useTranslation>;
type Breakdown = "people" | "models" | "spaces";
type PersonRow = AdminUsage["byUser"][number];
type ModelRow = AdminUsage["byModel"][number];
type SpaceRow = AdminUsage["bySpace"][number] & { readonly label: string };

const PERIODS: ReadonlyArray<{ value: UsagePeriod; label: (t: Translate) => string }> = [
  { value: "7d", label: (t) => t("Last 7 days") },
  { value: "30d", label: (t) => t("Last 30 days") },
  { value: "90d", label: (t) => t("Last 90 days") },
  { value: "month", label: (t) => t("This month") },
  { value: "last-month", label: (t) => t("Last month") },
];

const countColumns = <Row extends { chats?: number; turns: number }>(
  t: Translate,
  withChats: boolean,
): UsageColumn<Row>[] => [
  ...(withChats
    ? [
        {
          id: "chats",
          label: t("Chats"),
          numeric: true,
          secondary: true,
          value: (row: Row) => row.chats ?? 0,
          render: (row: Row) => formatCount(row.chats ?? 0),
        },
      ]
    : []),
  {
    id: "turns",
    label: t("Messages"),
    numeric: true,
    secondary: true,
    value: (row) => row.turns,
    render: (row) => formatCount(row.turns),
  },
];

function peopleColumns(t: Translate): UsageColumn<PersonRow>[] {
  return [
    {
      id: "name",
      label: t("Person"),
      value: (row) => row.name ?? row.email ?? t("Deleted account"),
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{row.name ?? row.email ?? t("Deleted account")}</span>
          {row.name && row.email ? (
            <span className="truncate text-xs text-muted-foreground">{row.email}</span>
          ) : null}
        </span>
      ),
    },
    { id: "email", label: t("Email"), csvOnly: true, value: (row) => row.email ?? "" },
    ...amountColumns<PersonRow>(t),
    ...countColumns<PersonRow>(t, true),
  ];
}

function modelRows(t: Translate): UsageColumn<ModelRow>[] {
  return [
    ...modelColumns<ModelRow>(t),
    ...amountColumns<ModelRow>(t),
    ...countColumns<ModelRow>(t, false),
  ];
}

function spaceColumns(t: Translate): UsageColumn<SpaceRow>[] {
  return [
    { id: "space", label: t("Space"), value: (row) => row.label },
    ...amountColumns<SpaceRow>(t),
    ...countColumns<SpaceRow>(t, true),
  ];
}

/** Personal spaces all share a name; their owner tells them apart. */
function spaceLabel(
  t: Translate,
  row: AdminUsage["bySpace"][number],
  spaces: ReadonlyMap<string, AdminSpace>,
): string {
  const space = spaces.get(row.spaceId);
  if (space?.kind === "personal")
    return t("Personal space of {{name}}", { name: space.ownerName ?? t("a deleted account") });
  return space?.name ?? row.name ?? t("Deleted space");
}

function download(filename: string, text: string) {
  // A byte-order mark, so spreadsheet apps read accents and currency signs as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  // On a phone, money and tokens share the first row and the three counts the second.
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 sm:col-span-1 sm:px-4",
        wide ? "col-span-3" : "col-span-2",
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-medium tabular-nums">{value}</span>
    </div>
  );
}

const loadSpaces = () => baskuleApi.adminSpaces();

/** One breakdown: its rows, sorting and CSV export, typed by its own columns. */
function BreakdownSection<Row extends { costUsd: number }>({
  title,
  rows,
  columns,
  rowKey,
  filename,
  picker,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<UsageColumn<Row>>;
  readonly rowKey: (row: Row) => string;
  readonly filename: string;
  readonly picker: ReactNode;
}) {
  const t = useTranslation();
  const [sort, setSort] = useState<UsageSort>({ column: "cost", descending: true });
  const sorted = sortRows(rows, columns, sort);
  return (
    // The pressed toggle names the breakdown; the table keeps the full name for screen readers.
    <PageSection
      title={t("Breakdown")}
      action={
        <>
          {picker}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("Download this table as CSV")}
            disabled={sorted.length === 0}
            onClick={() => download(filename, usageCsv(sorted, columns))}
          >
            <DownloadIcon />
            <span className="hidden sm:inline">{t("CSV")}</span>
          </Button>
        </>
      }
    >
      <UsageTable
        label={title}
        rows={sorted}
        columns={columns}
        rowKey={rowKey}
        sort={sort}
        onSortChange={setSort}
        bar={(row) => row.costUsd}
        emptyText={t("No messages in this period.")}
      />
    </PageSection>
  );
}

export function UsageDashboard() {
  const t = useTranslation();
  const locale = useLocale();
  const [shown, setShown] = useState(() => ({
    period: "30d" as UsagePeriod,
    ...periodRange("30d", Date.now()),
  }));
  // The compiler keeps this function's identity until `shown` changes, which is what reloads.
  const load = () => usageApi.admin({ from: shown.from, to: shown.to });
  const usage = useApiResource(load);
  const spaces = useApiResource(loadSpaces);
  const [breakdown, setBreakdown] = useState<Breakdown>("people");
  const data = usage.data;
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const rangeText = `${dateFormat.format(Date.parse(shown.from))} – ${dateFormat.format(Date.parse(shown.to))}`;
  const filename = `usage-${breakdown}-${shown.from}-to-${shown.to}.csv`;
  const picker = (
    <ToggleGroup
      aria-label={t("Breakdown")}
      variant="segmented"
      value={[breakdown]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "people" || value === "models" || value === "spaces") setBreakdown(value);
      }}
    >
      <Toggle value="people">{t("People")}</Toggle>
      <Toggle value="models">{t("Models")}</Toggle>
      <Toggle value="spaces">{t("Spaces")}</Toggle>
    </ToggleGroup>
  );
  const spaceById = new Map((spaces.data ?? []).map((space) => [space.id, space]));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 sm:px-4">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {rangeText}
          {usage.loading && data ? <Spinner size="sm" tone="muted" /> : null}
        </span>
        <div className="w-44">
          <Select
            value={shown.period}
            onValueChange={(value) => {
              const period = PERIODS.find((entry) => entry.value === value)?.value;
              if (period) setShown({ period, ...periodRange(period, Date.now()) });
            }}
          >
            <SelectTrigger aria-label={t("Period")} size="sm">
              <SelectValue>
                {(value: UsagePeriod) => PERIODS.find((entry) => entry.value === value)?.label(t)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {PERIODS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label(t)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {!data ? (
        <PageMessage>{usage.error ?? <Spinner />}</PageMessage>
      ) : (
        <>
          <div className="grid grid-cols-6 gap-3 sm:grid-cols-5">
            <Stat wide label={t("Cost")} value={formatUsd(data.totals.costUsd)} />
            <Stat wide label={t("Tokens")} value={formatTokens(data.totals.tokens)} />
            <Stat label={t("Active people")} value={formatCount(data.totals.activeUsers)} />
            <Stat label={t("Chats")} value={formatCount(data.totals.chats)} />
            <Stat label={t("Messages")} value={formatCount(data.totals.turns)} />
          </div>
          <UsageDailyChart title={t("Per day")} daily={data.daily} />
          {breakdown === "people" ? (
            <BreakdownSection
              key="people"
              title={t("Usage per person")}
              rows={data.byUser}
              columns={peopleColumns(t)}
              rowKey={(row) => row.userId}
              filename={filename}
              picker={picker}
            />
          ) : breakdown === "models" ? (
            <BreakdownSection
              key="models"
              title={t("Usage per model")}
              rows={data.byModel}
              columns={modelRows(t)}
              rowKey={(row) => `${row.provider}:${row.model}`}
              filename={filename}
              picker={picker}
            />
          ) : (
            <BreakdownSection
              key="spaces"
              title={t("Usage per space")}
              rows={data.bySpace.map((row) => ({ ...row, label: spaceLabel(t, row, spaceById) }))}
              columns={spaceColumns(t)}
              rowKey={(row) => row.spaceId}
              filename={filename}
              picker={picker}
            />
          )}
        </>
      )}
    </>
  );
}
