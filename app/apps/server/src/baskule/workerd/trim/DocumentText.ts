// baskule: workerd cannot spawn the upstream isolated office-document parser. Preserve its service key
// and serve existing text sidecars; uploads retain their originals for the computer's document tools.
// @effect-diagnostics deterministicKeys:off -- replacement uses the real service key.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Real from "../../../provider/DocumentText.ts";

const extensions = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb"]);
export const resolveExtractedTextPath = Effect.fn("DocumentText.resolveExtractedTextPath")(
  function* (path: string) {
    const extension = path.split(".").at(-1)?.toLowerCase();
    if (!extension || !extensions.has(extension)) return;
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path + ".txt").pipe(
      Effect.map((exists) => (exists ? path + ".txt" : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  },
);

export class DocumentText extends Context.Service<DocumentText, Real.DocumentText["Service"]>()(
  "t3/provider/DocumentText",
) {}
export const layer = Layer.effect(
  DocumentText,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return DocumentText.of({
      ensure: Effect.fnUntraced(function* (path: string) {
        return yield* resolveExtractedTextPath(path).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
    });
  }),
);
