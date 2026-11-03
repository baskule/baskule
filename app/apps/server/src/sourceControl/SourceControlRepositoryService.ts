import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  SourceControlProviderKind,
  type SourceControlRepositoryInfo,
} from "@t3tools/contracts";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isGitCommandError = Schema.is(GitCommandError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The Git operation could not be completed.",
          cause,
        }),
  );
}

// Redact credentials from client clone snapshots; git still receives the credentials.
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

function redactUrlCredentials(text: string): string {
  return text
    .replace(QUOTED_URL_QUERY, "$1$2$1")
    .replace(URL_QUERY, "$1")
    .replace(URL_WITH_USERINFO, "$1");
}

/**
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
        const parentPath = path.dirname(normalizedDestination);
        if (!(yield* fileSystem.exists(parentPath))) {
          yield* fileSystem.makeDirectory(parentPath, { recursive: true });
        }
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    const repository = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git mixes progress and diagnostics on stderr; retain non-progress tail lines for failure details.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    // Git misreads @ in a pathless URL's query as userinfo and echoes its suffix as the host.
    const normalizedCloneUrl = cloneUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", normalizedCloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const remoteUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.remoteUrl),
      // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - The condition also narrows httpsUrl for the fallback closure.
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              Effect.as(redactRemoteUrl(httpsUrl)),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only .git-bearing partial clones may be deleted; other files arrived after the empty-directory check.
    // Missing destinations are already discarded; other read failures must refuse removal.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // Preserve the workspace directory after removing partial contents; retry while interrupted git closes files.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  // Forwarders retain the underlying operation spans.
  return SourceControlRepositoryService.of({
    prepareClone: Effect.fnUntraced(function* (input) {
      return yield* prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    cloneRepository: Effect.fnUntraced(function* (input, options) {
      return yield* cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    discardClone: Effect.fnUntraced(function* (destinationPath) {
      return yield* discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
