// baskule: a space's T3 settings are managed by the installation, not by members (E8). The
// only provider is OpenCode in the space's AgentCell; the model comes from `BASKULE_LLM_*`.

export interface ManagedSettingsInput {
  /** OpenCode's API in the AgentCell (`http://agent/oc`). */
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
          // The AgentCell is reached through a DO stub, never a network: no password.
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
