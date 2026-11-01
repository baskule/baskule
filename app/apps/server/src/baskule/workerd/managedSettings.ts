// baskule: a space's T3 settings are managed by the installation, not by members. The
// only provider is the embedded OpenCode in this SpaceCell.

export interface ManagedSettingsInput {
  /** The embedded OpenCode API in this SpaceCell (`http://agent/oc`). */
  readonly agentUrl: string;
  /** Provider key in OpenCode's config, and the model id within it. */
  readonly providerId: string;
  readonly model: string;
}

export const managedSettingsJson = (input: ManagedSettingsInput): string => {
  const model = { instanceId: "opencode", model: `${input.providerId}/${input.model}` };
  return JSON.stringify(
    {
      providerInstances: {
        opencode: {
          driver: "opencode",
          enabled: true,
          // The embedded OpenCode is reached through a same-cell request, never a network: no password.
          config: { serverUrl: input.agentUrl },
        },
      },
      defaultModelSelection: model,
      textGenerationModelSelection: model,
      // No Done inbox in Baskule (rpcPolicy.ts refuses settle): the server never auto-settles.
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
    },
    null,
    2,
  );
};
