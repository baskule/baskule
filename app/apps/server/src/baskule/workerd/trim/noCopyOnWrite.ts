import type * as Real from "../../../noCopyOnWrite.ts";

// SpaceCell SQL owns its storage; app directories have no host btrfs attributes to change.
export const markNoCopyOnWrite: typeof Real.markNoCopyOnWrite = async () => {};
export const isNoCopyOnWrite: typeof Real.isNoCopyOnWrite = async () => false;
