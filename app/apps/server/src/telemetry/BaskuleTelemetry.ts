// baskule: Baskule deployments never phone home by default. Telemetry stays
// on by default upstream; here it defaults OFF when `BASKULE=1` or
// `BASKULE_AUTH_MODE` is set. An explicit `T3CODE_TELEMETRY_ENABLED` still wins.
import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const telemetryEnabledConfig = Config.all({
  explicit: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.option),
  baskule: Config.Boolean("BASKULE").pipe(Config.withDefault(false)),
  authMode: Config.String("BASKULE_AUTH_MODE").pipe(Config.option),
}).pipe(
  Config.map(({ explicit, baskule, authMode }) =>
    Option.getOrElse(explicit, () => !baskule && Option.isNone(authMode)),
  ),
);
