import { useMessages, msg } from "gt-react";


// baskule: compact run-status glyph for the flat chat list (replaces pin/PR/terminal/provider badges).
import { CircleAlertIcon, LoaderCircleIcon, MessageCircleQuestionIcon } from "lucide-react";

import type { SidebarThreadStatus } from "../components/Sidebar.logic";

export function BaskuleChatStatus({
  status,
  unread = false,
}: {
  readonly status: SidebarThreadStatus;
  readonly unread?: boolean;
}) {
  const t = useMessages();
  if (status === "working" || status === "waiting") {
    return (
      <LoaderCircleIcon
        role="img"
        aria-label={t(msg("Working"))}
        className="size-3.5 shrink-0 animate-spin text-info"
      />
    );
  }
  if (status === "input" || status === "approval") {
    return (
      <MessageCircleQuestionIcon
        role="img"
        aria-label={t(msg("Needs your answer"))}
        className="size-3.5 shrink-0 text-warning-foreground"
      />
    );
  }
  if (status === "failed" || status === "limited") {
    return (
      <CircleAlertIcon
        role="img"
        aria-label={t(msg("Failed"))}
        className="size-3.5 shrink-0 text-destructive-foreground"
      />
    );
  }
  if (unread) {
    return (
      <span
        role="img"
        aria-label={t(msg("Unread"))}
        className="size-2 shrink-0 rounded-full bg-info"
        data-testid="baskule-chat-unread"
      />
    );
  }
  return null;
}
