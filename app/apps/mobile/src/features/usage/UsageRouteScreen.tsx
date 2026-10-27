import { t, useTranslation } from "../../i18n";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";
type UsageTab = "usage" | "limits";
const TAB_OPTIONS = [
  {
    value: "usage",
    get label() {
      return t("Usage");
    },
  },
  {
    value: "limits",
    get label() {
      return t("Limits");
    },
  },
] as const satisfies readonly { value: UsageTab; label: string }[];

const WINDOW_OPTIONS = [
  {
    value: 1,
    label: "24h",
    get accessibilityLabel() {
      return t("Past 24 hours");
    },
  },
  {
    value: 7,
    label: "7d",
    get accessibilityLabel() {
      return t("Past 7 days");
    },
  },
  {
    value: 30,
    label: "30d",
    get accessibilityLabel() {
      return t("Past 30 days");
    },
  },
  {
    value: 90,
    label: "90d",
    get accessibilityLabel() {
      return t("Past 90 days");
    },
  },
] as const;

const METRIC_OPTIONS = [
  {
    value: "cost",
    get label() {
      return t("Cost");
    },
  },
  {
    value: "tokens",
    get label() {
      return t("Tokens");
    },
  },
] as const satisfies readonly { value: UsageChartMetric; label: string }[];

const CHART_HEIGHT = 180;
const providerLabel = (provider: UsageProviderKind) => PROVIDER_LABEL[provider];

export function UsageRouteScreen() {
  const t = useTranslation();
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState(() => ({
    params: route.params,
    tab: (route.params?.tab === "usage" ? "usage" : "limits") as UsageTab,
  }));
  if (selection.params !== route.params) {
    setSelection({
      params: route.params,
      tab: route.params?.tab === "usage" ? "usage" : "limits",
    });
  }
  const { tab } = selection;
  const setTab = (tab: UsageTab) => setSelection({ params: route.params, tab });
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { merged, environments, selectedEnvironments, isPending, refresh } = useUsage(
    window,
    selectedEnvironmentIds,
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && tab === "limits");

  const refreshAfterCursorEnable = () => {
    void refresh();
    void limits.refreshAfterEnable();
  };
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message && (source.status === "partial" || source.status === "failed")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = enumerateDays(window.sinceDay, window.untilDay);
  const chartDays =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? enumerateHourStarts(window.sinceTime, window.untilTime)
      : days;
  const chartTotals: readonly DailyTotals[] = isPast24Hours
    ? merged.hourly.map((hour) => ({
        day: hour.hourStart,
        costUsd: hour.costUsd,
        totalTokens: hour.totalTokens,
        byProvider: hour.byProvider,
      }))
    : merged.daily;

  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const showingLimits = tab === "limits";
  const progress = usageProgress(selectedEnvironments, {
    refreshing: refreshingUsage,
    providerLabel,
  });
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    if (refreshingRef.current) return;
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setRefreshingUsage(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setRefreshingUsage(false);
    });
  };

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = [
    {
      id: "all",
      title: t("All environments"),
      subtitle: undefined,
      state: selectedEnvironmentIds === null ? ("on" as const) : ("off" as const),
    },
    ...environments.map((environment) => ({
      id: environment.environmentId,
      title: environment.label,
      subtitle: usageEnvironmentStatus(environment, refreshingUsage),
      state:
        selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)
          ? ("on" as const)
          : ("off" as const),
    })),
  ];
  const selectEnvironment = (value: string) => {
    if (value === "all") {
      setSelectedEnvironmentIds(null);
      return;
    }
    const id = EnvironmentId.make(value);
    setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
  };
  const environmentFilter = showEnvironmentFilter ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("Filter usage environments")}
      title={t("Environments")}
      actions={environmentActions}
      onPressAction={({ nativeEvent }) => selectEnvironment(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Filter usage environments")}
        className={cn(
          "items-center justify-center rounded-full",
          Platform.OS === "ios" ? "size-[28px]" : "size-[44px]",
        )}
      >
        <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
      </Pressable>
    </Menu>
  ) : null;

  useLayoutEffect(() => {
    if (Platform.OS === "ios") {
      navigation.setOptions({ headerRight: () => environmentFilter });
    }
  }, [navigation, environmentFilter]);

  return (
    <SettingsScreen title={t("Usage")} trailing={environmentFilter}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          showingLimits || canReadDiagnostics ? (
            <RefreshControl
              refreshing={showingLimits ? limits.refreshing : refreshingUsage}
              onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
            />
          ) : undefined
        }
      >
        <SegmentedControl options={TAB_OPTIONS} selected={tab} onSelect={setTab} role="tab" />
        <Animated.View
          key={tab}
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          className="gap-6"
        >
          {showingLimits ? (
            <UsageLimitsSection
              now={limits.now}
              failedLabels={limits.failedLabels}
              selectedEnvironmentIds={selectedEnvironmentIds}
            />
          ) : (
            <>
              <View className="gap-3 ios:flex-row ios:items-center">
                <SegmentedControl
                  options={WINDOW_OPTIONS}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="w-full ios:flex-1"
                />
                <SegmentedControl
                  options={METRIC_OPTIONS}
                  selected={metric}
                  onSelect={setMetric}
                  size="compact"
                  className="w-full ios:w-36"
                />
              </View>

              {merged.duplicateSources.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  {t("Counted once across environments sharing a transcript directory:")}{" "}
                  {merged.duplicateSources.join(", ")}
                </Text>
              ) : null}
              {isPending ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  {t("Scanning provider transcripts…")}
                </Text>
              ) : selectedEnvironments.length === 0 ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  {environments.length === 0
                    ? t("Connect an environment to see usage.")
                    : t("Select an environment to see usage.")}
                </Text>
              ) : !canReadDiagnostics ? (
                <View className="gap-2 py-16">
                  {selectedEnvironments.map((environment) => (
                    <Text
                      key={environment.environmentId}
                      className="text-center text-base text-foreground-muted"
                    >
                      {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                      {environment.error}
                    </Text>
                  ))}
                </View>
              ) : (
                <>
                  {sourceMessages.map((message) => (
                    <Text key={message} className="text-sm text-foreground-muted">
                      {message}
                    </Text>
                  ))}
                  <UsageUpdating dimmed={progress.dimmed} label={progress.label}>
                    <ChartCard
                      merged={merged}
                      days={chartDays}
                      daily={chartTotals}
                      metric={metric}
                      sinceDay={window.sinceDay}
                      untilDay={window.untilDay}
                      isPast24Hours={isPast24Hours}
                      timeZone={window.timeZone}
                    />
                    <ProviderSection merged={merged} metric={metric} />
                    <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
                    <CostSection merged={merged} />
                    <ModelsSection merged={merged} metric={metric} />
                  </UsageUpdating>
                </>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>
    </SettingsScreen>
  );
}

function UsageUpdating({
  dimmed,
  label,
  children,
}: {
  readonly dimmed: boolean;
  readonly label: string | null;
  readonly children: ReactNode;
}) {
  const opacity = useSharedValue(1);
  useLayoutEffect(() => {
    opacity.set(
      dimmed
        ? withDelay(150, withTiming(0.5, { duration: 150, reduceMotion: ReduceMotion.System }))
        : withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System }),
    );
  }, [opacity, dimmed]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <View>
      <Animated.View style={dimStyle} className="gap-6" accessibilityState={{ busy: dimmed }}>
        {children}
      </Animated.View>
      {label !== null ? (
        <Animated.View
          entering={FadeIn.delay(150).duration(150).reduceMotion(ReduceMotion.System)}
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          className="absolute right-4 top-4 h-5 max-w-[55%] flex-row items-center gap-1.5"
        >
          <AppActivityIndicator size="small" colorClassName="accent-adaptive-sky-600-400" />
          <Text className="shrink text-sm text-adaptive-sky-600-400" numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
}) {
  const t = useTranslation();
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="gap-0.5">
        <Text className="text-sm text-foreground-muted">
          {metric === "cost" ? t("Raw token cost") : t("Processed tokens")}
        </Text>
        <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
          {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {metric === "cost"
            ? t("* if billed at full API rate")
            : t("Across {{value1}} sessions", { value1: formatCount(merged.sessions) })}
        </Text>
      </View>

      {hasActivity ? (
        <UsageDailyChart
          days={props.days}
          daily={props.daily}
          metric={metric}
          height={CHART_HEIGHT}
        />
      ) : (
        <View style={{ height: CHART_HEIGHT }} className="items-center justify-center">
          <Text className="text-base text-foreground-muted">
            {t("No activity in this window.")}
          </Text>
        </View>
      )}

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[0] ?? "", props.timeZone)
              : formatDayShort(props.sinceDay)}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
              : formatDayShort(props.untilDay)}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
          {merged.providers.map((provider) => (
            <View key={provider.provider} className="flex-row items-center gap-1.5">
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: colors[provider.provider] }}
              />
              <Text className="text-xs text-foreground-muted">
                {PROVIDER_LABEL[provider.provider]}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
}) {
  const t = useTranslation();
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;

  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title={t("Providers")}>
      {ordered.map((provider, index) => {
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text className="text-lg text-foreground">{PROVIDER_LABEL[provider.provider]}</Text>
              </View>
              <Text className="text-lg tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ flex: share, backgroundColor: colors[provider.provider] }}
              />
              <View style={{ flex: 1 - share }} />
            </View>
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? t("{{value1}} of cost · {{value2}} tokens", {
                    value1: formatPercent(share),
                    value2: formatTokens(provider.totalTokens),
                  })
                : t("{{value1}} of tokens · {{value2}}", {
                    value1: formatPercent(share),
                    value2: formatUsd(provider.costUsd),
                  })}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: { readonly merged: MergedUsage; readonly isPast24Hours: boolean }) {
  const t = useTranslation();
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title={t("Totals")}>
      <View className="flex-row flex-wrap">
        <MetricCell
          label={t("Processed tokens")}
          value={formatTokens(merged.totalTokens)}
          detail={t("{{value1}} per active {{value2}}", {
            value1: formatTokens(periodAverage),
            value2: props.isPast24Hours ? t("hour") : t("day"),
          })}
        />
        <MetricCell
          label={t("Cache savings")}
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? t("{{value1}}x the raw cost", {
                  value1: (merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1),
                })
              : t("vs full input rates")
          }
        />
        <MetricCell
          label={t("Cached input")}
          value={formatTokens(merged.cachedInputTokens)}
          detail={t("{{value1}} of observed input", { value1: formatPercent(cachedShare) })}
        />
        <MetricCell
          label={t("Uncached input")}
          value={formatTokens(merged.uncachedInputTokens)}
          detail={t("{{value1}} cache writes", {
            value1: formatTokens(merged.cacheCreationTokens),
          })}
        />
        <MetricCell
          label={t("Output")}
          value={formatTokens(merged.outputTokens)}
          detail={t("incl. {{value1}} reasoning", { value1: formatTokens(merged.reasoningTokens) })}
        />
        <MetricCell
          label={t("Unpriced")}
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail={t("of records, excluded from cost")}
        />
      </View>
    </SettingsSection>
  );
}

function CostSection(props: { readonly merged: MergedUsage }) {
  const t = useTranslation();
  const { categoryCost, speedCost } = props.merged;
  const colors = useUsageMixColors();
  const byType = [
    { label: t("Input"), value: categoryCost.input, color: colors.input },
    { label: t("Cache read"), value: categoryCost.cacheRead, color: colors.cacheRead },
    { label: t("Cache write"), value: categoryCost.cacheWrite, color: colors.cacheWrite },
    { label: t("Output"), value: categoryCost.output, color: colors.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    {
      label: t("Other"),
      value: categoryCost.unsplit >= 0.005 ? categoryCost.unsplit : 0,
      color: colors.other,
    },
  ];
  const bySpeed = [
    { label: t("Standard"), value: speedCost.standard, color: colors.standard },
    { label: t("Fast"), value: speedCost.fast, color: colors.fast },
    { label: t("Ultrafast"), value: speedCost.ultrafast, color: colors.ultrafast },
  ];
  if (props.merged.costUsd <= 0) return null;

  return (
    <SettingsSection title={t("Cost")}>
      <ShareBar label={t("By type")} segments={byType} />
      {speedCost.fast + speedCost.ultrafast > 0 ? (
        <View className="border-t border-border-subtle">
          <ShareBar
            label={t("By speed")}
            segments={bySpeed}
            aside={`${formatUsd(speedCost.premium)} premium`}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

function ShareBar(props: {
  readonly label: string;
  readonly segments: readonly { label: string; value: number; color: string }[];
  readonly aside?: string;
}) {
  const visible = props.segments.filter((segment) => segment.value > 0);
  if (visible.length === 0) return null;

  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        {props.aside ? (
          <Text className="text-sm tabular-nums text-foreground-muted">{props.aside}</Text>
        ) : null}
      </View>
      <View className="h-2 flex-row gap-0.5">
        {visible.map((segment) => (
          <View
            key={segment.label}
            className="h-full rounded-sm"
            style={{ flex: segment.value, backgroundColor: segment.color }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
        {visible.map((segment) => (
          <View key={segment.label} className="flex-row items-center gap-1.5">
            <View className="size-2 rounded-sm" style={{ backgroundColor: segment.color }} />
            <Text className="text-sm text-foreground-muted">{segment.label}</Text>
            <Text className="text-sm tabular-nums text-foreground">{formatUsd(segment.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <View className="w-1/2 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: { readonly merged: MergedUsage; readonly metric: UsageChartMetric }) {
  const t = useTranslation();
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.models].sort((a, b) =>
    metric === "cost"
      ? b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );

  return (
    <SettingsSection title={t("By model")}>
      {ordered.map((model, index) => (
        <View
          key={`${model.provider}:${model.model}`}
          className={
            index === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
        >
          <View
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors[model.provider] }}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {model.model}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {metric === "tokens"
                ? t("{{value1}} of tokens · {{value2}}", {
                    value1: formatPercent(model.tokenShare),
                    value2: isModelCostUnknown(model)
                      ? t("no known rates")
                      : formatUsd(model.costUsd),
                  })
                : isModelCostUnknown(model)
                  ? t("no known rates · {{value1}} tokens", {
                      value1: formatTokens(model.totalTokens),
                    })
                  : t("{{value1}} of cost · {{value2}} tokens", {
                      value1: formatPercent(model.costShare),
                      value2: formatTokens(model.totalTokens),
                    })}
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">
            {metric === "tokens"
              ? formatTokens(model.totalTokens)
              : isModelCostUnknown(model)
                ? t("Unpriced")
                : formatUsd(model.costUsd)}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}

function usageEnvironmentStatus(environment: EnvironmentUsageStatus, refreshing: boolean): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return formatUsageContractMismatch(environment.label, {
      direction:
        environment.summary.contractVersion < USAGE_CONTRACT_VERSION
          ? "serverBehind"
          : "clientBehind",
    });
  }
  if (environment.error)
    return environment.summary ? `${environment.error} Showing saved totals.` : environment.error;
  if (!environment.isConnected)
    return environment.summary ? "Disconnected · showing saved usage" : "Waiting for connection…";
  const progress = usageEnvironmentProgress(environment, refreshing);
  if (progress.phase === "loading") return "Loading usage…";
  if (progress.phase === "stale") return "Updating usage…";
  if (progress.phase === "partway")
    return updatingProvidersLabel(progress.providers, providerLabel);
  return "Usage up to date";
}
