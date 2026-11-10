import {
  CloudSpeechCredentials,
  isSecretReference,
  type SettingsSecretValue,
  EasDeviceHostConfig,
  type ProviderInstanceConfig,
  type ServerSettings,
  secretSettingsFields,
} from "@t3tools/contracts";
import { openCodeClient } from "@t3tools/provider-opencode/client";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSecretFields = new Map([
  [openCodeClient.driverKind, secretSettingsFields(openCodeClient.settingsSchema)],
]);
const voiceSecretFields = secretSettingsFields(CloudSpeechCredentials);
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;
type SecretSlotName = (field: string, serverHost: string | null) => string;
type SecretFieldsMapper = (
  fields: Readonly<Record<string, unknown>>,
  secretFields: ReadonlyArray<string>,
  name: SecretSlotName,
) => Record<string, unknown>;
type ProviderEnvironment = NonNullable<ProviderInstanceConfig["environment"]>;

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields: SecretFieldsMapper = (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next) || isSecretReference(next[field])) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  return mapSecretFieldGroups(settings, mapFields, (instanceId, environment) =>
    environment.map((variable) => {
      const { valueRedacted: _omit, ...rest } = variable;
      // A secret reference is not itself secret; storage sees the value cleared.
      const reference = typeof variable.value === "string" ? undefined : variable.value;
      const result = map({
        secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
        kind: "environment",
        value: typeof variable.value === "string" ? variable.value : "",
        redacted: reference === undefined && variable.valueRedacted === true,
        sensitive: variable.sensitive,
        providerInstanceId: instanceId,
        environmentVariable: variable.name,
      });
      if (reference !== undefined) return { ...rest, value: reference };
      return {
        ...rest,
        value: result.value,
        ...(result.redacted ? { valueRedacted: true } : {}),
      };
    }),
  );
}

export function mapSettingsSecretValues(
  settings: ServerSettings,
  map: (value: SettingsSecretValue, secretName: string) => SettingsSecretValue,
): ServerSettings {
  const mapValue = (value: unknown, secretName: string) =>
    typeof value === "string" || isSecretReference(value) ? map(value, secretName) : value;
  return mapSecretFieldGroups(settings, (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      const value = next[field];
      next[field] =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isSecretReference(value)
          ? Object.fromEntries(
              Object.entries(value).map(([serverHost, entry]) => [
                serverHost,
                mapValue(entry, name(field, serverHost.trim().toLowerCase())),
              ]),
            )
          : mapValue(value, name(field, null));
    }
    return next;
  });
}

function mapSecretFieldGroups(
  settings: ServerSettings,
  mapFields: SecretFieldsMapper,
  mapEnvironment: (instanceId: string, environment: ProviderEnvironment) => ProviderEnvironment = (
    _instanceId,
    environment,
  ) => environment,
): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? { environment: mapEnvironment(instanceId, instance.environment) }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, legacySourceControlSecretFields.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const easDeviceHosts = settings.easDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        easDeviceHostSecretFields,
        (field, serverHost) =>
          `device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as EasDeviceHostConfig,
  );

  return {
    ...settings,
    providerInstances,
    sourceControlHosts,
    easDeviceHosts,
    cloudSpeechCredentials: mapFields(
      settings.cloudSpeechCredentials,
      voiceSecretFields,
      (provider) => `voice-cloud-${provider}`,
    ) as ServerSettings["cloudSpeechCredentials"],
  };
}

// Released settings and secret references must remain redacted after integrations retire.
const legacySourceControlSecretFields: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["github", ["tokens"]],
  ["bitbucket", ["accessToken", "apiToken"]],
  ["gitcafe", ["token"]],
]);

export interface SourceControlHostSecretSlot {
  readonly kind: string;
  readonly field: string;
  readonly serverHost: string | null;
}

/** The secret store entry for one slot; names stay stable across releases. */
export function sourceControlHostSecretName(slot: SourceControlHostSecretSlot): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return slot.serverHost === null
    ? `source-control-${encode(slot.kind)}-${encode(slot.field)}`
    : `source-control-${encode(slot.kind)}-${encode(slot.field)}-${encode(slot.serverHost.trim().toLowerCase())}`;
}

export function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (isSecretReference(value)) return [];
  if (typeof value === "string") return [[null, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
  );
}

export function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (typeof original === "string") return values[0]?.[1] ?? "";
  return Object.fromEntries(values.map(([serverHost, value]) => [serverHost ?? "", value]));
}
