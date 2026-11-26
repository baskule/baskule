import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import type { ReviewParsedDiff } from "./reviewModel";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { filterReviewTestFiles } from "./reviewFileFilters";

export function useHideTestFilesPreference() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const hideTestFiles =
    AsyncResult.isSuccess(preferences) && preferences.value.pullRequestHideTestFiles === true;
  return {
    hideTestFiles,
    toggle: () => {
      void savePreferences({ pullRequestHideTestFiles: !hideTestFiles });
    },
    showAll: () => {
      void savePreferences({ pullRequestHideTestFiles: false });
    },
  };
}

export function useReviewFileFilter(parsed: ReviewParsedDiff, includePath?: string) {
  const preference = useHideTestFilesPreference();
  const { hideTestFiles } = preference;
  const visible = useMemo(
    () => filterReviewTestFiles(parsed, hideTestFiles, includePath),
    [parsed, hideTestFiles, includePath],
  );
  const hiddenCount =
    parsed.kind === "files" && visible.kind === "files" ? parsed.fileCount - visible.fileCount : 0;
  return { ...preference, parsed: visible, hiddenCount };
}
