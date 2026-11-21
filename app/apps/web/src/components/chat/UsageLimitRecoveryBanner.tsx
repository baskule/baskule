import { msg, useGT } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";

import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";

import { InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** baskule: which limit refused the message, in the product's words. */
  copy?: { readonly title: string; readonly description: string } | undefined;
};

export function usageLimitRecoveryBannerItem(
  props: RecoveryProps,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const {
    runId,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const resetDescription = displayAt
    ? resumes
      ? resolve(
          msg("Resumes {time}", {
            time: formatUpcomingTimestamp(
              displayAt,
              timestampFormat,
              undefined,
              undefined,
              resolve,
            ),
          }),
        )
      : resolve(
          msg("Resets {time}", {
            time: formatUpcomingTimestamp(
              displayAt,
              timestampFormat,
              undefined,
              undefined,
              resolve,
            ),
          }),
        )
    : resolve(msg("Reset time unavailable; retry manually"));
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <GaugeIcon />,
    title: props.copy?.title ?? resolve(msg("Usage limit reached")),
    description: props.copy?.description ?? resetDescription,
    actions: canSchedule ? <RecoveryActions {...props} /> : undefined,
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const gt = useGT();
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: m(msg("Could not snooze thread")),
        description: m(msg("The reset time has passed. Retry the thread manually.")),
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title:
          action === "resume"
            ? m(msg("Could not change auto-resume"))
            : m(msg("Could not snooze thread")),
        description: thrownErrorMessage(cause, m) ?? m(msg("An error occurred.")),
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? gt("Saving...") : scheduled ? gt("Cancel auto-resume") : gt("Resume at reset")}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? gt("Saving...") : snoozed ? gt("Wake now") : gt("Snooze until reset")}
      </InlineButton>
    </span>
  );
}
