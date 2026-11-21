import * as Schema from "effect/Schema";

export const PreviewBridgeBinding = Schema.Struct({
  environmentId: Schema.String,
  connectionId: Schema.String,
  threadId: Schema.String,
  tabId: Schema.String,
  transportGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PreviewBridgeBinding = typeof PreviewBridgeBinding.Type;

export function samePreviewBinding(a: PreviewBridgeBinding, b: PreviewBridgeBinding): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.connectionId === b.connectionId &&
    a.threadId === b.threadId &&
    a.tabId === b.tabId &&
    a.transportGeneration === b.transportGeneration
  );
}
