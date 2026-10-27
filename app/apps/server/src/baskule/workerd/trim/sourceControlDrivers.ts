// baskule: workerd replacement for `sourceControl/builtInDrivers.ts` (see build.mjs). A space has no git remotes
// (git, pull requests and reviews are off: rpcPolicy.ts), so no source-control provider driver is registered; their
// API clients were ~0.7 MiB. Kept: the source-control host and GitHub credentials (the asset route's GitHub media
// fetch reads them; without `gh` or a token they answer "unavailable", as before).
import type { SourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "../../../sourceControl/ServerSourceControlHost.ts";

export type BuiltInSourceControlDriversEnv = never;

export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = [];

export const layer = GitHubCredentials.layer.pipe(
  Layer.provideMerge(ServerSourceControlHost.layer),
);
