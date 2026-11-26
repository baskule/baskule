import * as Config from "effect/Config";
import * as Option from "effect/Option";

// Baskule deployments also default to no analytics outside CI.
export const telemetryEnabledConfig = (enabledByDefault: boolean) =>
  Config.all({
    explicit: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.option),
    baskule: Config.Boolean("BASKULE").pipe(Config.withDefault(false)),
    authMode: Config.String("BASKULE_AUTH_MODE").pipe(Config.option),
  }).pipe(
    Config.map(({ explicit, baskule, authMode }) =>
      Option.getOrElse(explicit, () => enabledByDefault && !baskule && Option.isNone(authMode)),
    ),
  );
