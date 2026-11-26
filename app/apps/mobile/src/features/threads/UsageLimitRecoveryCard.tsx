import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useDeadlinePassed } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    thread.settledOverride !== "settled" &&
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const displayPassed = useDeadlinePassed(
    thread.snoozedUntil
      ? Date.parse(thread.snoozedUntil)
      : resetAt === null
        ? null
        : Date.parse(resetAt),
  );
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  const displayAt =
    canSchedule &&
    scheduled &&
    resetAt &&
    thread.snoozedUntil &&
    Date.parse(thread.snoozedUntil) > Date.parse(resetAt)
      ? thread.snoozedUntil
      : resetAt;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !runId
  )
    return null;
  const resumesUpcoming = canSchedule && scheduled && !displayPassed;
  const shownAt = resumesUpcoming ? displayAt : resetAt;
  const resetDate = shownAt
    ? new Date(shownAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const snoozed =
    limitRecoveryOwnsSnooze({
      runId,
      resetAt,
      recovery,
      snoozedUntil: thread.snoozedUntil,
    }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError(gt("The reset time has passed. Retry the thread manually."));
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        limitRecovery: {
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        },
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(errorDisplayMessage(cause, m) ?? gt("Could not change limit recovery."));
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm text-warning-foreground">
          {resetDate === null
            ? gt(
                "Usage limit reached. The provider did not report a reset time. Retry manually when your limit is available.",
              )
            : resumesUpcoming
              ? gt("Usage limit reached. Resumes {date}.", { date: resetDate })
              : resetPassed
                ? gt("Usage limit reached. Reset {date}.", { date: resetDate })
                : gt("Usage limit reached. Resets {date}.", { date: resetDate })}
        </Text>
        {canSchedule ? (
          <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
            <RecoveryAction
              label={
                scheduled
                  ? gt("Cancel auto-resume")
                  : resetPassed
                    ? gt("Resume now")
                    : gt("Resume at reset")
              }
              disabled={pending}
              onPress={() => void toggle("resume")}
            />
            <RecoveryAction
              label={snoozed ? gt("Wake now") : gt("Snooze until reset")}
              disabled={pending || (!snoozed && resetPassed)}
              onPress={() => void toggle("snooze")}
            />
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function RecoveryAction(props: {
  readonly label: string;
  readonly role?: "button" | "link";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.role ?? "button"}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
