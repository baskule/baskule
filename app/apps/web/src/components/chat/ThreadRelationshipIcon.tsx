import { t } from "../../i18n";

import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return t("Starting");
    case "running":
    case "in_progress":
      return t("Running");
    case "pending":
    case "queued":
      return t("Queued");
    case "waiting":
    case "blocked":
      return t("Waiting");
    case "completed":
      return t("Done");
    case "failed":
    case "error":
      return t("Failed");
    case "cancelled":
    case "interrupted":
      return t("Stopped");
    case "rolled_back":
      return t("Reverted");
    case "resolved_native":
      return t("Resolved (native)");
    case "resolved_portable":
      return t("Resolved (portable)");
    case "consumed":
      return t("Consumed");
    case "superseded":
      return t("Superseded");
    case "idle":
      return t("Idle");
    default:
      return t("Unknown");
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}

          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
