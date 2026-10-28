// baskule: the composer's limit notice. Silent until a limit is close (NEAR_LIMIT_SHARE); once a
// limit is reached it says which one and when messages can be sent again, before anyone types.
import { Link } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { t as translate, useLocale, useTranslation } from "../../i18n";
import { Button } from "../../components/ui/button";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import type { ComposerBannerStackItem } from "../../components/chat/ComposerBannerStack";
import { baskule } from "../flags";
import { usageApi, type UsageWindowStatus } from "./api";
import {
  NEAR_LIMIT_SHARE,
  formatShare,
  nearestWindow,
  resetSentence,
  windowCopy,
  windowShare,
} from "./format";
import { CompactUsageLimitBars } from "./UsageLimitBars";

// setTimeout's ceiling; a later reset is picked up by the next settled turn anyway.
const MAX_TIMER_MS = 2_147_483_647;

/** The banner for the person's limits, or null. */
export function usageLimitBanner(input: {
  readonly limits: ReadonlyArray<UsageWindowStatus>;
  readonly now: number;
  readonly locale: string;
  readonly dismissed: string | null;
  readonly onDismiss: (key: string) => void;
}): ComposerBannerStackItem | null {
  const nearest = nearestWindow(input.limits);
  if (nearest === null) return null;
  const share = windowShare(nearest);
  if (!nearest.blocked && share < NEAR_LIMIT_SHARE) return null;
  const copy = windowCopy(nearest.window);
  // Inset like T3's limits banner, so the bars line up under the title.
  const children = (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="pt-1 pb-1.5 pe-2">
        <CompactUsageLimitBars limits={input.limits} />
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
  const actions = <SeeUsageLink />;
  if (nearest.blocked) {
    return {
      id: `baskule-usage-blocked:${nearest.window}:${nearest.resetsAt}`,
      variant: "warning",
      icon: <GaugeIcon />,
      title: copy.reached,
      description: resetSentence(nearest, input.now, input.locale),
      actions,
      children,
    };
  }
  // A notice dismissed at 80% comes back at 90%, and with the next window.
  const key = `${nearest.window}:${nearest.resetsAt}:${Math.floor(share * 10)}`;
  if (input.dismissed === key) return null;
  return {
    id: `baskule-usage-near:${key}`,
    variant: "info",
    icon: <GaugeIcon />,
    title: copy.name,
    description: `${translate("{{share}} used", { share: formatShare(share) })} · ${resetSentence(nearest, input.now, input.locale)}`,
    actions,
    children,
    dismissLabel: translate("Dismiss usage limit notice"),
    onDismiss: () => input.onDismiss(key),
  };
}

function SeeUsageLink() {
  const t = useTranslation();
  return (
    <Button size="xs" variant="ghost" render={<Link to="/settings/usage" />}>
      {t("See usage")}
    </Button>
  );
}

/**
 * `refreshKey` changes when a turn settles (its usage is then counted). Hidden while T3's
 * recovery banner already reports the refusal of this chat's last message.
 */
export function useUsageComposerBanner(input: {
  readonly refreshKey: string | null;
  readonly hidden: boolean;
}): ComposerBannerStackItem | null {
  const locale = useLocale();
  const [state, setState] = useState<{
    readonly limits: ReadonlyArray<UsageWindowStatus>;
    readonly at: number;
    /** The settled turn (or reset) these figures follow. */
    readonly after: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [resetTick, setResetTick] = useState(0);
  const after = `${input.refreshKey ?? ""}:${resetTick}`;

  // oxlint-disable-next-line t3code/react-effect-budget -- Fetch server usage after a turn settles or a limit resets.
  useEffect(() => {
    if (!baskule.hosted) return;
    let cancelled = false;
    usageApi.me().then(
      (usage) => {
        if (!cancelled) setState({ limits: usage.limits, at: Date.now(), after });
      },
      // Usage is advisory here: the server still enforces limits when it is unreachable.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [after]);

  // Refresh when the next window resets, so a blocked notice does not outlive its limit.
  const nextReset = state?.limits.reduce<number | null>((soonest, status) => {
    const time = Date.parse(status.resetsAt);
    return Number.isNaN(time) ? soonest : soonest === null ? time : Math.min(soonest, time);
  }, null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Schedule a refresh against the server-provided reset timestamp.
  useEffect(() => {
    if (nextReset === null || nextReset === undefined) return;
    const timer = window.setTimeout(
      () => setResetTick((tick) => tick + 1),
      Math.min(Math.max(1_000, nextReset - Date.now() + 1_000), MAX_TIMER_MS),
    );
    return () => window.clearTimeout(timer);
  }, [nextReset]);

  if (!baskule.hosted || input.hidden || state === null) return null;
  return usageLimitBanner({
    limits: state.limits,
    now: state.at,
    locale,
    dismissed,
    onDismiss: setDismissed,
  });
}
