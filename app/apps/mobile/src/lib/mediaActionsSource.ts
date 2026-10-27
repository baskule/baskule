import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AuthFilesystemReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { FileBackedComposerAttachment } from "./composerImages";

export type MediaActionsSource = {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
  readonly sourceIdentifier?: string;
} & (
  | { readonly uri: string }
  | { readonly attachment: FileBackedComposerAttachment }
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly resource: AssetResource;
    }
);

export function assetExportResource(resource: AssetResource): AssetResource {
  switch (resource._tag) {
    case "workspace-file":
    case "draft-workspace-file":
    case "attachment":
      return { ...resource, disposition: "attachment" };
    case "media-file":
      return { ...resource, _tag: "workspace-file", disposition: "attachment" };
    default:
      return resource;
  }
}

export function assetReadScope(resource: AssetResource) {
  return resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file"
    ? AuthFilesystemReadScope
    : AuthOrchestrationReadScope;
}
