import { NavigationContext } from "@react-navigation/native";
import { use, useCallback, useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { BackHandler } from "react-native";

/**
 * Android hardware back while `active` and the owning screen is focused.
 * Keyed on those alone, not `onBack`: BackHandler calls the newest listener
 * first, so re-registering per render lets a covered screen consume Back.
 */
export function useHardwareBack(active: boolean, onBack: () => boolean) {
  const focused = useIsScreenFocused();
  const handleBack = useEffectEvent(onBack);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler for the focused screen's lifetime
  useEffect(() => {
    if (!active || !focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => handleBack());
    return () => subscription.remove();
  }, [active, focused]);
}

// `useIsFocused` throws outside a navigator, where the signed-out login screen renders.
// Content outside a navigator has no competing screen, so it counts as focused.
function useIsScreenFocused(): boolean {
  const navigation = use(NavigationContext);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!navigation) return () => {};
      const unsubscribeFocus = navigation.addListener("focus", onChange);
      const unsubscribeBlur = navigation.addListener("blur", onChange);
      return () => {
        unsubscribeFocus();
        unsubscribeBlur();
      };
    },
    [navigation],
  );
  const isFocused = () => navigation?.isFocused() ?? true;
  return useSyncExternalStore(subscribe, isFocused, isFocused);
}
