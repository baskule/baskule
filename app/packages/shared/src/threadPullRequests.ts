import { canonicalRepositoryKey } from "./git.ts";
import type {
  OrchestrationV2AppThread,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

/** Tombstones prevent sync from re-adding hidden members. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

function latestUpdatedAt(link: ThreadPullRequestLink): number {
  const value = link.snapshot?.updatedAt ?? link.linkedAt;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export interface ThreadSearchPullRequest {
  readonly number: number;
  readonly title: string | null;
  /** `owner/repo#123` and the pull request URL, matched only by a whole query. */
  readonly references: ReadonlyArray<string>;
}

const SEARCHED_PULL_REQUEST_TITLES = 3;

/** Pull requests thread search matches by number, title, and reference. */
export function threadSearchPullRequests(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): ThreadSearchPullRequest[] {
  const entry = (
    link: Pick<ThreadLinkedPullRequest, "number" | "repository" | "url">,
    title: string | null,
  ): ThreadSearchPullRequest => ({
    number: link.number,
    title,
    references: [`${link.repository}#${link.number}`, link.url],
  });
  const branch = thread.branchPullRequest ? [entry(thread.branchPullRequest, null)] : [];
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    // Every pull request matches by number and link, but only the newest few
    // by title: a triage thread linked to dozens would match almost any word.
    const newestFirst = [...visibleThreadPullRequests(thread.pullRequests)].sort(
      (left, right) => latestUpdatedAt(right) - latestUpdatedAt(left),
    );
    return branch.concat(
      newestFirst.map((link, index) =>
        entry(link, index < SEARCHED_PULL_REQUEST_TITLES ? (link.snapshot?.title ?? null) : null),
      ),
    );
  }
  return thread.linkedPullRequest ? branch.concat(entry(thread.linkedPullRequest, null)) : branch;
}

export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  return threadSearchPullRequests(thread).flatMap((pullRequest) => [
    `#${pullRequest.number}`,
    ...pullRequest.references,
    ...(pullRequest.title ? [pullRequest.title] : []),
  ]);
}

type ThreadPullRequestKeySource = ThreadPullRequestKey & {
  readonly authority?: string;
  readonly url?: string;
};

// Frozen URL rules preserve released event metadata; no forge operation uses this parser.
interface FrozenLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly authority?: string;
}

function isHostOf(hostname: string, apex: string, label: string): boolean {
  return hostname === apex || hostname.endsWith(`.${apex}`) || hostname.split(".").includes(label);
}

function claim(host: string, match: RegExpExecArray | null): FrozenLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

export function legacyPullRequestKeyFromUrl(targetUrl: string): FrozenLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host === "git.cafe" || host === "staging.git.cafe") {
    const match = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (match) return claim(host, match);
  } else {
    if (isHostOf(host, "github.com", "github")) {
      const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
    const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (forgejo) {
      const link = claim(host, forgejo);
      return link === null ? null : { ...link, authority: url.host.toLowerCase() };
    }
    const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    if (gitlab) return claim(host, gitlab);
    if (isHostOf(host, "bitbucket.org", "bitbucket")) {
      const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
      if (match) return claim(host, match);
    }
  }
  const azure = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const link = claim(host, azure);
  return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
}

export function normalizeThreadPullRequestKey(
  key: ThreadPullRequestKeySource,
): ThreadPullRequestKey {
  const parsed = key.url === undefined ? null : legacyPullRequestKeyFromUrl(key.url);
  const authority =
    key.authority ??
    (parsed?.repository === key.repository.trim().toLowerCase() && parsed.number === key.number
      ? parsed.authority
      : undefined);
  const canonical = canonicalRepositoryKey(
    `${(authority ?? key.host).trim().toLowerCase()}/${key.repository.trim().toLowerCase()}`,
  );
  const separator = canonical.indexOf("/");
  return {
    host: canonical.slice(0, separator),
    repository: canonical.slice(separator + 1),
    number: key.number,
  };
}

export function legacyThreadPullRequestKey(
  linked: Pick<ThreadLinkedPullRequest, "repository" | "number" | "url">,
  fallbackHost?: string,
): ThreadPullRequestKey {
  const parsed = legacyPullRequestKeyFromUrl(linked.url);
  if (parsed !== null && parsed.number === linked.number) {
    if (
      parsed.authority !== undefined ||
      canonicalRepositoryKey(`${parsed.host}/${parsed.repository}`).startsWith("dev.azure.com/")
    ) {
      return normalizeThreadPullRequestKey(parsed);
    }
  }
  let host = fallbackHost;
  if (host === undefined) {
    try {
      host = new URL(linked.url).hostname;
    } catch {
      host = "unknown";
    }
  }
  return {
    host: host.trim().toLowerCase() || "unknown",
    repository: linked.repository.trim().toLowerCase(),
    number: linked.number,
  };
}

export function threadPullRequestKeysEqual(
  left: ThreadPullRequestKeySource,
  right: ThreadPullRequestKeySource,
): boolean {
  return threadPullRequestKeyOf(left) === threadPullRequestKeyOf(right);
}

// Clients re-derive chains for every link on each render, and normalizing parses the
// link's URL. Links are immutable and keep their identity until they change.
const normalizedKeys = new WeakMap<ThreadPullRequestKeySource, ThreadPullRequestKey>();

export function normalizedKeyOf(key: ThreadPullRequestKeySource): ThreadPullRequestKey {
  let normalized = normalizedKeys.get(key);
  if (normalized === undefined) {
    normalized = normalizeThreadPullRequestKey(key);
    normalizedKeys.set(key, normalized);
  }
  return normalized;
}

export function threadPullRequestKeyOf(key: ThreadPullRequestKeySource): string {
  const normalized = normalizedKeyOf(key);
  return `${normalized.host}/${normalized.repository}#${normalized.number}`;
}

/** Older V2 event payloads stored one link; an explicit empty array means it was unlinked. */
export function threadPullRequestsOf(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): ReadonlyArray<ThreadPullRequestLink> {
  if (thread.pullRequests !== undefined) return thread.pullRequests;
  const linked = thread.linkedPullRequest;
  return linked == null
    ? []
    : [
        {
          ...legacyThreadPullRequestKey(linked),
          url: linked.url,
          source: "manual",
          linkedAt: "1970-01-01T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ];
}

export function applyThreadPullRequestLinkUpdate(
  thread: OrchestrationV2AppThread,
  updated: ThreadPullRequestLink,
): OrchestrationV2AppThread {
  return {
    ...thread,
    pullRequests: threadPullRequestsOf(thread).map((link) =>
      threadPullRequestKeysEqual(link, updated) ? updated : link,
    ),
  };
}

export function canonicalizeLegacyPullRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return value;
    if (url.hostname !== "git.cafe" && url.hostname !== "staging.git.cafe") return value;
    const match = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:\/|$)/u.exec(url.pathname);
    const number = Number(match?.[2]);
    return match?.[1] && Number.isSafeInteger(number) && number > 0
      ? `https://${url.hostname}/${match[1].toLowerCase()}/pulls/${number}`
      : value;
  } catch {
    return value;
  }
}
