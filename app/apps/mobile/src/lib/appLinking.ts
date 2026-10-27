import { BASKULE_FLAGS } from "../baskule/flags";

export function isConnectAppLink(url: string): boolean {
  return /^baskule(?:-dev|-preview)?:\/\/connect(?:[/?#]|$)/i.test(url);
}

export function shouldHandleAppLink(value: string): boolean {
  if (isConnectAppLink(value)) return false;
  try {
    const url = new URL(value);
    if (!/^(baskule|t3code)(-dev|-preview)?:$/.test(url.protocol) && url.protocol !== "exp:")
      return false;
    const path = `${url.hostname}/${url.pathname}`.replace(/\/+/g, "/");
    if (path.includes("expo-development-client") || path.includes("expo-sharing")) return false;
    if (/^\/*$/.test(path)) return false;
    if (!BASKULE_FLAGS.pullRequests && /(^|\/)pull-requests(\/|$)/.test(path)) return false;
    if (!BASKULE_FLAGS.terminal && /^threads\/[^/]+\/[^/]+\/terminal(?:\/|$)/.test(path))
      return false;
    if (
      !BASKULE_FLAGS.sourceControl &&
      /^threads\/[^/]+\/[^/]+\/(?:review|review-comment|git|git-confirm)(?:\/|$)/.test(path)
    )
      return false;
    if (!BASKULE_FLAGS.devicePreviews && /^threads\/[^/]+\/[^/]+\/devices(?:\/|$)/.test(path))
      return false;
    return true;
  } catch {
    return false;
  }
}
