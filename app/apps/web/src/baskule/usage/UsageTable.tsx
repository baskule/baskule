// baskule: usage rows (people, models, spaces) in T3's usage-table style, sortable by any column.
// The same column list produces the CSV, so an export matches what is on screen.
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { USAGE_COLOR, toCsv } from "./format";

export interface UsageColumn<Row> {
  readonly id: string;
  readonly label: string;
  /** Sort key, and the CSV cell unless `csv` is given. */
  readonly value: (row: Row) => string | number;
  readonly render?: (row: Row) => ReactNode;
  readonly csv?: (row: Row) => string | number;
  /** The CSV header, when the screen's label leaves out a unit. */
  readonly csvLabel?: string;
  /** In the CSV only, such as an email the screen shows under the name. */
  readonly csvOnly?: boolean;
  readonly numeric?: boolean;
  /** Secondary columns give way on a phone; the CSV keeps them. */
  readonly secondary?: boolean;
}

export interface UsageSort {
  readonly column: string;
  readonly descending: boolean;
}

export function sortRows<Row>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<UsageColumn<Row>>,
  sort: UsageSort,
): Row[] {
  const column = columns.find((entry) => entry.id === sort.column);
  if (!column) return [...rows];
  const direction = sort.descending ? -1 : 1;
  return rows.toSorted((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    const order =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
    return order * direction;
  });
}

export function usageCsv<Row>(rows: ReadonlyArray<Row>, columns: ReadonlyArray<UsageColumn<Row>>) {
  return toCsv([
    columns.map((column) => column.csvLabel ?? column.label),
    ...rows.map((row) => columns.map((column) => (column.csv ?? column.value)(row))),
  ]);
}

export function UsageTable<Row>({
  label,
  rows,
  columns,
  rowKey,
  sort,
  onSortChange,
  bar,
  emptyText,
}: {
  readonly label: string;
  /** Already sorted: see `sortRows`. */
  readonly rows: ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<UsageColumn<Row>>;
  readonly rowKey: (row: Row) => string;
  readonly sort?: UsageSort;
  readonly onSortChange?: (sort: UsageSort) => void;
  /** A thin bar under the first cell, relative to the largest row. */
  readonly bar?: (row: Row) => number;
  readonly emptyText: string;
}) {
  const peak = bar ? Math.max(0, ...rows.map(bar)) : 0;
  const shown = columns.filter((column) => !column.csvOnly);
  const [first, ...rest] = shown;
  if (!first) return null;
  const header = (column: UsageColumn<Row>) => {
    const active = sort?.column === column.id;
    const content = (
      <>
        {column.label}
        {active ? (
          sort.descending ? (
            <ArrowDownIcon aria-hidden className="size-3" />
          ) : (
            <ArrowUpIcon aria-hidden className="size-3" />
          )
        ) : null}
      </>
    );
    return (
      <th
        key={column.id}
        scope="col"
        aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
        className={cn(
          "py-2 font-normal",
          column === first
            ? "w-full ps-3 text-left sm:ps-4"
            : "ps-6 text-right last:pe-3 sm:last:pe-4",
          column.secondary && "hidden sm:table-cell",
        )}
      >
        {onSortChange ? (
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active && "text-foreground",
            )}
            onClick={() =>
              onSortChange({
                column: column.id,
                // Figures start with the largest; names start at A.
                descending: active ? !sort.descending : column.numeric === true,
              })
            }
          >
            {content}
          </button>
        ) : (
          content
        )}
      </th>
    );
  };
  return (
    <table className="w-full text-sm" aria-label={label}>
      <thead>
        <tr className="border-b border-border/50 text-xs whitespace-nowrap text-muted-foreground">
          {shown.map(header)}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={shown.length} className="px-3 py-6 text-center text-muted-foreground">
              {emptyText}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const value = bar ? bar(row) : 0;
            return (
              <tr
                key={rowKey(row)}
                className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums last:border-b-0"
              >
                <td className="max-w-0 py-2.5 ps-3 text-left whitespace-normal text-foreground sm:ps-4">
                  {(first.render ?? first.value)(row)}
                  {peak > 0 && value > 0 ? (
                    <div aria-hidden className="mt-1.5 h-0.5 max-w-48">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `max(0.5rem, ${(value / peak) * 100}%)`,
                          backgroundColor: USAGE_COLOR,
                        }}
                      />
                    </div>
                  ) : null}
                </td>
                {rest.map((column, index) => (
                  <td
                    key={column.id}
                    className={cn(
                      "py-2.5 ps-6 last:pe-3 sm:last:pe-4",
                      index === 0 && "text-foreground",
                      column.secondary && "hidden sm:table-cell",
                    )}
                  >
                    {(column.render ?? column.value)(row)}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
