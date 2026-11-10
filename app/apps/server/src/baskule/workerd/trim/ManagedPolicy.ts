// SpaceCells have no machine policy files or registry. Baskule's membership and RPC policy
// enforce hosted capabilities; keep upstream policy consumers on one explicit unmanaged service.
// @effect-diagnostics deterministicKeys:off -- replacement uses the real service key.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Real from "../../../policy/ManagedPolicy.ts";
import { unmanagedSettings } from "../../../policy/managedSettings.ts";
import { unmanagedProviders } from "../../../policy/managedProviders.ts";

export class ManagedPolicy extends Context.Service<ManagedPolicy, Real.ManagedPolicy["Service"]>()(
  "t3/policy/ManagedPolicy",
) {}

export const layer = Layer.succeed(ManagedPolicy, {
  path: "/baskule/policy.json",
  document: undefined,
  settings: unmanagedSettings,
  providers: unmanagedProviders,
  summary: undefined,
});

export const loadedPolicy = (_policy: Pick<Real.ManagedPolicy["Service"], "path" | "document">) =>
  Effect.succeed(null);

export function deniedBy(
  policy: Pick<Real.ManagedPolicy["Service"], "document">,
  capability: "webhookTasks" | "telemetry",
): string | undefined {
  return policy.document?.limits?.[capability] === false ? policy.document.organization : undefined;
}
