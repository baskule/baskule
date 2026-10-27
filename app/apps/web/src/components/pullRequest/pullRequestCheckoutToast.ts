import { t } from "../../i18n";
export const OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST = {
  type: "warning",
  get title() {
    return t("Checked out, but not confirmed on the latest commit");
  },
  get description() {
    return t(
      "This checkout could not be confirmed at the pull request's latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
    );
  },
} as const;
