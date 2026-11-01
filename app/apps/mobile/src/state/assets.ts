import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { assetExportResource, assetReadScope } from "../lib/mediaActionsSource";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { readBaskuleSession, useBaskuleSession } from "../baskule/session";
import {
  bindTransferLifetime,
  isTransferOriginCurrent,
  type TransferOrigin,
} from "../connection/native-transfer";
import {
  downloadAttachmentForPreview,
  type AttachmentPreviewFile,
} from "../lib/attachmentDownload";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

function assetFileName(resource: AssetResource): string {
  return "fileName" in resource && resource.fileName
    ? resource.fileName
    : "path" in resource && resource.path
      ? (resource.path.split("/").at(-1) ?? "asset")
      : "asset";
}

function useTransferOrigin(environmentId: EnvironmentId | null) {
  const prepared = usePreparedConnection(environmentId);
  const session = useBaskuleSession();
  const connection = prepared._tag === "Some" ? prepared.value : null;
  const serverUrl = session.status === "signed-in" ? session.serverUrl : null;
  const token = session.status === "signed-in" ? session.token : null;
  return useMemo(() => {
    if (!connection) return null;
    const origin = { connection, serverUrl, token };
    return isTransferOriginCurrent(origin) ? origin : null;
  }, [connection, serverUrl, token]);
}

export function useAssetConnectionLifetime(
  environmentId: EnvironmentId | null,
  onInvalidated: () => void,
  scope: AuthEnvironmentScope = AuthOrchestrationReadScope,
) {
  const origin = useTransferOrigin(environmentId);
  const invalidate = useEffectEvent(onInvalidated);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The viewer subscribes to account and authorization revocation for its mounted lifetime.
  useEffect(() => {
    if (environmentId === null || origin === null) return;
    const controller = new AbortController();
    const lifetime = bindTransferLifetime({
      environmentId,
      origin,
      signal: controller.signal,
      invalidate,
      scope,
    });
    return () => {
      lifetime.dispose();
      controller.abort();
    };
  }, [environmentId, origin, scope]);
}

/** Viewers receive account-owned local bytes, never front credentials. */
export function useManagedAssetUri(input: {
  readonly environmentId: EnvironmentId | null;
  readonly url: string | null;
  readonly name: string;
  readonly scope?: AuthEnvironmentScope;
}) {
  const origin = useTransferOrigin(input.environmentId);
  const [cached, setCached] = useState<{ url: string; origin: TransferOrigin; uri: string } | null>(
    null,
  );
  const [failed, setFailed] = useState<{ url: string; origin: TransferOrigin } | null>(null);
  const { environmentId, url, name, scope } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Downloaded native previews retain a revocable file lease until the viewer unmounts.
  useEffect(() => {
    if (!origin || environmentId === null || url === null) return;
    const controller = new AbortController();
    let file: AttachmentPreviewFile | null = null;
    void downloadAttachmentForPreview({
      url,
      transfer: { environmentId, origin, scope },
      signal: controller.signal,
      attachment: { name, mimeType: "application/octet-stream" },
      onInvalidated: () => setCached(null),
    })
      .then((value) => {
        if (controller.signal.aborted) return value?.dispose();
        file = value;
        if (value) setCached({ url, origin, uri: value.uri });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed({ url, origin });
      });
    return () => {
      controller.abort();
      file?.dispose();
    };
  }, [environmentId, url, name, origin, scope]);
  return {
    uri: cached?.url === url && cached.origin === origin ? cached.uri : null,
    failed: failed?.url === url && failed.origin === origin,
  };
}

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectCloneListAtom,
});

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const fileAccessSession = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const shared =
    blocked ??
    assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    );
  const remoteState = deriveAssetUrlState({
    connectionPhase,
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
  const managed = useManagedAssetUri({
    environmentId,
    url: remoteState._tag === "Success" ? remoteState.url : null,
    name: resource ? assetFileName(resource) : "asset",
    scope: resource ? assetReadScope(resource) : AuthOrchestrationReadScope,
  });
  if (remoteState._tag !== "Success") return remoteState;
  return managed.uri
    ? { ...remoteState, url: managed.uri }
    : managed.failed
      ? { _tag: "Failure", reason: "failed" }
      : { _tag: "Loading" };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  disposition?: "attachment",
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const origin = useTransferOrigin(environmentId);
  const [stableResource, setStableResource] = useState(resource);
  if (JSON.stringify(stableResource) !== JSON.stringify(resource)) setStableResource(resource);
  const files = useRef(new Set<AttachmentPreviewFile>());
  const controller = useRef(new AbortController());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Native export leases are disposed with the owning mounted viewer.
  useEffect(() => {
    controller.current = new AbortController();
    const currentFiles = files.current;
    return () => {
      controller.current.abort();
      for (const file of currentFiles) file.dispose();
      currentFiles.clear();
    };
  }, []);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return async () => {
    const resource = stableResource;
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    if (origin === null) return null;
    const state = assetUrlStateFromResult(
      await createUrl({
        environmentId,
        input: { resource: disposition ? assetExportResource(resource) : resource },
      }),
      httpBaseUrl,
    );
    if (state._tag !== "Success") return null;
    const file = await downloadAttachmentForPreview({
      url: state.url,
      transfer: { environmentId, origin, scope: assetReadScope(resource) },
      signal: controller.current.signal,
      attachment: { name: assetFileName(resource), mimeType: "application/octet-stream" },
    });
    if (!file) return null;
    files.current.add(file);
    return file.uri;
  };
}

/** {@link useRefreshAssetUrl} for async tasks that resolve several resources at once. */
export async function refreshAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  signal: AbortSignal,
): Promise<string | null> {
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  const initialConnection = appAtomRegistry.get(connectionAtom);
  if (initialConnection._tag === "None") return null;
  const session = readBaskuleSession();
  const origin = {
    connection: initialConnection.value,
    serverUrl: session.status === "signed-in" ? session.serverUrl : null,
    token: session.status === "signed-in" ? session.token : null,
  };
  if (!isTransferOriginCurrent(origin)) return null;
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    label: atom.label?.[0] ?? "asset url",
    refresh: true,
    reportFailure: false,
    signal,
  });
  // A route can change while the query runs; resolve against the connection now current.
  const connection = appAtomRegistry.get(connectionAtom);
  if (connection._tag === "None") return null;
  const state = assetUrlStateFromResult(result, connection.value.httpBaseUrl);
  if (state._tag !== "Success" || !isTransferOriginCurrent(origin)) return null;
  const file = await downloadAttachmentForPreview({
    url: state.url,
    transfer: { environmentId, origin, scope: assetReadScope(resource) },
    signal,
    attachment: { name: assetFileName(resource), mimeType: "application/octet-stream" },
  });
  if (!file) return null;
  if (signal.aborted) {
    file.dispose();
    return null;
  }
  signal.addEventListener("abort", file.dispose, { once: true });
  return file.uri;
}

export interface AuthorizedAssetUrl {
  readonly url: string;
  readonly authorizedAt: number;
}

interface FreshAssetUrlKey {
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  /** A reconnect changes the base URL, and any URL minted against the old one is unusable. */
  readonly httpBaseUrl: string | null;
  /** Bumped by Retry so a file replaced on disk is reauthorized. */
  readonly revision: number;
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const freshAssetUrlFamily = Atom.family((key: FreshAssetUrlKey) =>
  Atom.make(
    Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    ).pipe(
      Effect.flatMap((controller) =>
        Effect.tryPromise({
          try: async (signal): Promise<AuthorizedAssetUrl> => {
            const url =
              key.environmentId === null
                ? null
                : await refreshAssetUrl(
                    key.environmentId,
                    key.resource,
                    AbortSignal.any([signal, controller.signal]),
                  );
            if (!url) throw new Error("Reconnect to this environment and try again.");
            return { url, authorizedAt: Date.now() };
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("The attachment is unavailable."),
        }),
      ),
    ),
  ).pipe(Atom.withLabel("fresh-asset-url")),
);

const noFreshAssetUrl = Atom.make(AsyncResult.initial<AuthorizedAssetUrl, Error>()).pipe(
  Atom.withLabel("fresh-asset-url:none"),
);
const noSessionGeneration = Atom.make(0);

/**
 * A signed URL minted when the reader mounts, not a cached one: cached links can
 * expire while the client is suspended.
 */
export function useFreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision: number,
): AsyncResult.AsyncResult<AuthorizedAssetUrl, Error> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const atom =
    resource === null
      ? noFreshAssetUrl
      : freshAssetUrlFamily({ environmentId, resource, httpBaseUrl, revision });
  // Minting fails at once while the environment is unreachable; mint again once a new session is
  // up instead of keeping the error until Retry.
  const sessionGeneration =
    environmentId === null
      ? noSessionGeneration
      : environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    if (AsyncResult.isFailure(appAtomRegistry.get(atom))) appAtomRegistry.refresh(atom);
  });
  return useAtomValue(atom);
}
