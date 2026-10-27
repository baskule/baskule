import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { assetExportResource, assetReadScope } from "../lib/mediaActionsSource";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { useBaskuleSession } from "../baskule/session";
import {
  bindTransferLifetime,
  isTransferOriginCurrent,
  type TransferOrigin,
} from "../lib/nativeTransfer";
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
  return useCallback(async () => {
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
  }, [createUrl, environmentId, httpBaseUrl, stableResource, disposition, origin]);
}
