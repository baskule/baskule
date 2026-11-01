import { useTranslation } from "../i18n";

// baskule: "Files out" (scope 2026-10-22, review M7). Any file the agent wrote downloads through
// the signed `/api/assets` route with `disposition: "attachment"`: the server streams it (Range
// supported), so type and size do not matter and nothing is buffered in the page.
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { workspaceAssetResource } from "~/components/files/filePreviewMode";
import { FileSurfaceAction } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export interface WorkspaceFileDownloadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly workspaceRoot: string;
  readonly absolutePath: string;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || "download";
}

function useWorkspaceFileDownload(target: WorkspaceFileDownloadTarget) {
  const t = useTranslation();
  const [pending, setPending] = useState(false);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const download = async () => {
    setPending(true);
    return (async () => {
      const connection = readPreparedConnection(target.environmentId);
      if (!connection) throw new Error("Reconnect and try again.");
      const resource = {
        ...workspaceAssetResource({ kind: "workspace-file", ...target }),
        disposition: "attachment",
      } as const;
      const result = await createAssetUrl({
        environmentId: target.environmentId,
        input: { resource },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error("The server returned an invalid download link.");
      // A plain link: the browser streams the response to disk (Content-Disposition: attachment).
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileNameOf(target.absolutePath);
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    })()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("Could not download the file"),
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .finally(() => {
        setPending(false);
      });
  };
  return { download, pending };
}

/** Header action shown for every previewed workspace file. */
export function WorkspaceFileDownloadAction(props: WorkspaceFileDownloadTarget) {
  const t = useTranslation();
  const { download, pending } = useWorkspaceFileDownload(props);
  return (
    <FileSurfaceAction
      label={pending ? t("Preparing download…") : t("Download file")}
      disabled={pending}
      onPress={() => void download()}
    >
      <DownloadIcon className="size-3.5" />
    </FileSurfaceAction>
  );
}

/** Body for files the preview cannot show (binary: zip, xlsx, docx, …). */
export function WorkspaceFileNoPreview(props: WorkspaceFileDownloadTarget) {
  const t = useTranslation();
  const { download, pending } = useWorkspaceFileDownload(props);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-foreground">{fileNameOf(props.absolutePath)}</p>
      <p className="text-xs text-muted-foreground">{t("This file can't be previewed here.")}</p>
      <Button type="button" variant="outline" disabled={pending} onClick={() => void download()}>
        <DownloadIcon />
        {t("Download")}
      </Button>
    </div>
  );
}
