import { m as resolveMessage } from "../../../i18n/messages";
import { msg, useMessages } from "gt-react";

// baskule: General → Overview: live health of every space and its computer, and the usage summary.
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { type ComputerState, type SpaceStatusView, baskuleApi } from "../../api";
import { confirmAction, notifyError, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";
import { OverviewUsage } from "./OverviewUsage";

const COMPUTER_LABELS: Record<
  ComputerState,
  { label: string; variant: "success" | "info" | "secondary" | "error" | "warning" }
> = {
  running: {
    get label() {
      return resolveMessage(msg("Computer running"));
    },
    variant: "success",
  },
  starting: {
    get label() {
      return resolveMessage(msg("Computer starting"));
    },
    variant: "info",
  },
  stopping: {
    get label() {
      return resolveMessage(msg("Computer stopping"));
    },
    variant: "info",
  },
  stopped: {
    get label() {
      return resolveMessage(msg("Computer asleep"));
    },
    variant: "secondary",
  },
  error: {
    get label() {
      return resolveMessage(msg("Computer error"));
    },
    variant: "error",
  },
  unknown: {
    get label() {
      return resolveMessage(msg("Computer unknown"));
    },
    variant: "warning",
  },
};

export function healthSummary(rows: ReadonlyArray<{ readonly status: SpaceStatusView | null }>) {
  const statuses = rows.flatMap((row) => (row.status ? [row.status] : []));
  return {
    awake: statuses.filter((status) => status.awake).length,
    computers: statuses.filter(
      (status) => status.computer === "running" || status.computer === "starting",
    ).length,
    runs: statuses.reduce((total, status) => total + status.activeRuns, 0),
    problems: statuses.filter((status) => status.error !== null || status.computer === "error")
      .length,
  };
}

const loadLiveSpaces = () => baskuleApi.adminSpaces({ live: true });

export function OverviewPage() {
  const t = useMessages();
  const health = useApiResource(loadLiveSpaces, { pollMs: 15_000 });
  const [stopping, setStopping] = useState<string | null>(null);
  const rows = health.data ?? [];
  const summary = healthSummary(rows);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t(msg("Spaces awake")), value: `${summary.awake} / ${rows.length}` },
          { label: t(msg("Computers running")), value: String(summary.computers) },
          { label: t(msg("Answers in progress")), value: String(summary.runs) },
          { label: t(msg("Problems")), value: String(summary.problems) },
        ].map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 sm:px-4"
          >
            <span className="text-xs text-muted-foreground">{stat.label}</span>
            <span className="text-lg font-medium tabular-nums">
              {health.data ? stat.value : "–"}
            </span>
          </div>
        ))}
      </div>
      <OverviewUsage />
      <PageSection
        title={t(msg("Spaces"))}
        description={t(
          msg(
            "Refreshed every 15 seconds. An asleep space uses no memory and wakes on the next request.",
          ),
        )}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void health.reload()}
            disabled={health.loading}
          >
            <RefreshCwIcon />
            {t(msg("Refresh"))}
          </Button>
        }
      >
        <ResourceState
          error={health.error}
          loading={health.loading}
          empty={rows.length === 0}
          emptyText={t(msg("No spaces."))}
        />
        {rows.map((row) => {
          const status = row.status;
          const computer = COMPUTER_LABELS[status?.computer ?? "unknown"];
          const busy =
            status !== null &&
            (status.awake || status.activeRuns > 0 || computer.variant === "success");
          return (
            <PageRow
              key={row.id}
              leading={
                <span
                  aria-hidden
                  className={
                    status?.error
                      ? "size-2 shrink-0 rounded-full bg-destructive"
                      : status?.awake
                        ? "size-2 shrink-0 rounded-full bg-success"
                        : "size-2 shrink-0 rounded-full bg-muted-foreground/40"
                  }
                />
              }
              trailing={
                <>
                  {status ? <Badge variant={computer.variant}>{computer.label}</Badge> : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!busy || stopping === row.id}
                    onClick={() =>
                      void confirmAction(
                        `Stop ${row.kind === "personal" ? `the personal space of ${row.ownerName ?? "this person"}` : row.name}?\nAnswers in progress are interrupted and the computer stops. Files are kept; it starts again on the next task.`,
                      ).then(async (confirmed) => {
                        if (!confirmed) return;
                        setStopping(row.id);
                        return (async () => {
                          await baskuleApi.stopSpace(row.id);
                          await health.reload();
                        })()
                          .catch((cause: unknown) => {
                            notifyError(t(msg("Could not stop the space")), cause);
                          })
                          .finally(() => {
                            setStopping(null);
                          });
                      })
                    }
                  >
                    {stopping === row.id ? <Spinner size="sm" /> : null}
                    {t(msg("Stop"))}
                  </Button>
                </>
              }
            >
              <span className="truncate text-sm text-foreground">
                {row.kind === "personal" ? (row.ownerName ?? row.name) : row.name}
                <span className="text-muted-foreground">
                  {row.kind === "personal" ? t(msg(" · personal")) : ""}
                </span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {status === null
                  ? t(msg("Not checked yet"))
                  : t(msg("{value1} · {sockets} {value3} · {activeRuns} {value5} in progress"), {
                      value1: status.awake ? t(msg("Awake")) : t(msg("Asleep")),
                      sockets: status.sockets,
                      value3: status.sockets === 1 ? t(msg("connection")) : t(msg("connections")),
                      activeRuns: status.activeRuns,
                      value5: status.activeRuns === 1 ? t(msg("answer")) : t(msg("answers")),
                    })}
              </span>
              {status?.error ? (
                <span className="text-xs text-destructive-foreground">{status.error}</span>
              ) : null}
            </PageRow>
          );
        })}
      </PageSection>
    </>
  );
}
