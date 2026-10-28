// @effect-diagnostics deterministicKeys:off -- replacement uses the real service key.
// baskule: no source-control drivers on the hosted space. Preserve the upstream service key.
import type { SourceControlDriverEntry } from "../../../sourceControl/builtInDrivers.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as ServerSourceControlHost from "../../../sourceControl/ServerSourceControlHost.ts";

export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

export const layer = Layer.succeed(SourceControlDrivers, []).pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
);
