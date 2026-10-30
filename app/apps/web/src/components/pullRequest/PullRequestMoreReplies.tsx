import { useTranslation } from "../../i18n";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
}: PullRequestReplyAvailability) {
  const t = useTranslation();
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? t("{{value1}} more reply", {
              value1: moreReplies.toLocaleString(),
              count: moreReplies,
              defaultValue_other: "{{value1}} more replies",
            })
          : t("More replies")}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {t("View on host")}
        </a>
      ) : null}
    </div>
  );
}
