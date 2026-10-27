// baskule: shared helpers for the workerd stubs in this directory (see build.mjs). A stub replaces a host-bound
// T3 module in the space-cell bundle: same exports and service keys, an inert implementation, so the layers that
// require it still build and the features it backs answer "unsupported" (their RPCs are off in rpcPolicy.ts anyway).
export const unsupportedInBaskule = (feature: string) =>
  `${feature} is unsupported in Baskule (a space cell has no host processes).`;
