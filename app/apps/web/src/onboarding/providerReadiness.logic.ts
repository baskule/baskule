import {
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

export function resolveOnboardingProviderInstallCommand(
  _driver: "opencode",
  _platform: ExecutionEnvironmentPlatformOs,
): string {
  return "npm install -g @opencode/cli@2.1.2";
}

export function resolveOnboardingProviderLoginCommand(
  _provider: ServerProvider,
  _settings: ServerSettings,
  _platform: ExecutionEnvironmentPlatformOs,
): string {
  return "opencode auth login";
}
