import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv = OpenCodeDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  OpenCodeDriver,
];

export type BuiltInUsageReadersEnv = ProviderUsageReaderEnv<typeof OpenCodeDriver>;

/**
 * Aggregation keeps the first copy of a duplicate record, so the order is part
 * of the result.
 */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [OpenCodeDriver];
