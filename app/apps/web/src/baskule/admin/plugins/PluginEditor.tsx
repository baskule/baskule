// baskule: the one editor for a plugin an admin brings: the review of an import before it is saved,
// a new MCP server, and later edits. Nothing reaches the server until Save; entered keys are written
// after the plugin itself, through the write-only key route.
import { addressPlaceholders, serverFingerprint } from "@t3tools/contracts/baskule-plugin-formats";
import type {
  CredentialMode,
  Fix,
  Group,
  Omission,
  PluginInput,
  ServerInput,
} from "@t3tools/contracts/baskule-plugins";
import { BookOpenTextIcon, ChevronRightIcon, PlugIcon } from "lucide-react";
import { useId, useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { pluginErrorText, pluginsApi } from "../../plugins/api";
import {
  GroupChoiceRows,
  NotUsedList,
  PluginIcon,
  useGroupChoice,
} from "../../plugins/PluginParts";
import {
  contentsKind,
  CREDENTIAL_MODES,
  credentialDescription,
  credentialLabel,
  includedSummary,
} from "../../plugins/presentation";
import { FormField, RowIcon } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";

export type EditorTarget =
  | {
      readonly type: "create";
      readonly groups: ReadonlyArray<Group> | null;
      readonly groupsError: string | null;
    }
  | {
      readonly type: "edit";
      readonly id: string;
      /** Servers whose organization key is already saved. */
      readonly savedKeys: ReadonlySet<string>;
    };

interface KeyEntry {
  readonly header: string;
  readonly value: string;
}

const DEFAULT_KEY: ReadonlyArray<KeyEntry> = [{ header: "Authorization", value: "" }];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** `{tenant}` and `${TENANT}` are shown to people as `tenant` and `TENANT`. */
const placeholderName = (token: string) => token.replace(/^\$?\{|\}$/g, "");

export function PluginEditor({
  initial,
  fixes,
  omitted,
  target,
  onCancel,
  onSaved,
}: {
  readonly initial: PluginInput;
  /** What the import found to fix in place: sign-in, address placeholders, keys. */
  readonly fixes: ReadonlyArray<Fix>;
  readonly omitted: ReadonlyArray<Omission>;
  readonly target: EditorTarget;
  readonly onCancel: () => void;
  readonly onSaved: (saved: { readonly id: string; readonly name: string }) => void;
}) {
  const t = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [icon, setIcon] = useState(initial.icon ?? "");
  const [servers, setServers] = useState<ReadonlyArray<ServerInput>>(initial.servers);
  const [fills, setFills] = useState<Readonly<Record<number, Readonly<Record<string, string>>>>>(
    {},
  );
  const [keys, setKeys] = useState<Readonly<Record<number, ReadonlyArray<KeyEntry>>>>(() =>
    Object.fromEntries(
      initial.servers.flatMap((server, index) => {
        const fix = fixes.find((entry) => entry.server === server.name && entry.need === "key");
        return fix?.need === "key"
          ? [[index, fix.headers.map((header) => ({ header, value: "" }))]]
          : server.keyHeaders?.length
            ? [[index, server.keyHeaders.map((header) => ({ header, value: "" }))]]
            : [];
      }),
    ),
  );
  const chosen = useGroupChoice(target.type === "create" ? target.groups : null);
  // Set once a new plugin exists, so a retry after a failed key save updates it instead.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();

  const signInFixes = new Set(
    fixes.filter((fix) => fix.need === "sign_in").map((fix) => fix.server),
  );
  const keyEntries = (index: number) => keys[index] ?? DEFAULT_KEY;
  const resolvedUrl = (index: number) => {
    const server = servers[index]!;
    return addressPlaceholders(server.url).reduce((url, token) => {
      const value = fills[index]?.[token]?.trim();
      return value ? url.split(token).join(value) : url;
    }, server.url.trim());
  };
  const finalServers: ServerInput[] = servers.map((server, index) => {
    const url = resolvedUrl(index);
    const { oauth, keyHeaders: _keyHeaders, ...rest } = server;
    return {
      ...rest,
      ...(server.credential === "user-oauth" && oauth ? { oauth } : {}),
      ...(server.credential === "organization"
        ? { keyHeaders: keyEntries(index).map((entry) => entry.header.trim()) }
        : {}),
      name: server.name || hostOf(url) || "server",
      url,
    };
  });
  const input: PluginInput = {
    name: name.trim(),
    description: description.trim(),
    ...(icon.trim() ? { icon: icon.trim() } : {}),
    source: initial.source,
    servers: finalServers,
    skills: initial.skills,
    omitted: initial.omitted,
  };

  const headersChanged = (index: number) =>
    target.type === "edit" &&
    target.savedKeys.has(servers[index]!.name) &&
    JSON.stringify(keyEntries(index).map((entry) => entry.header.trim())) !==
      JSON.stringify(initial.servers[index]!.keyHeaders ?? ["Authorization"]);
  const keyProblem = (index: number) => {
    const entries = keyEntries(index);
    const filled = entries.filter((entry) => entry.value !== "").length;
    return (
      (filled > 0 || headersChanged(index)) &&
      (filled < entries.length || entries.some((e) => !e.header.trim()))
    );
  };
  const invalid =
    !input.name ||
    (input.servers.length === 0 && input.skills.length === 0) ||
    servers.some(
      (server, index) =>
        !server.url.trim() ||
        addressPlaceholders(resolvedUrl(index)).length > 0 ||
        (server.credential === "organization" && keyProblem(index)),
    );

  const save = async () => {
    setAttempted(true);
    if (invalid || saving) return;
    setSaving(true);
    setError(null);
    let id = target.type === "edit" ? target.id : createdId;
    let stage: "plugin" | "keys" = "plugin";
    return (async () => {
      if (id) await pluginsApi.update(id, { plugin: input });
      else {
        id = (await pluginsApi.create({ plugin: input, groups: [...chosen.value] })).id;
        setCreatedId(id);
      }
      stage = "keys";
      for (const [index, server] of input.servers.entries()) {
        if (server.credential !== "organization") continue;
        const entries = keyEntries(index);
        if (entries.every((entry) => entry.value === "")) continue;
        await pluginsApi.secret(id, {
          server: server.name,
          headers: Object.fromEntries(entries.map((entry) => [entry.header.trim(), entry.value])),
        });
      }
      onSaved({ id, name: input.name });
    })()
      .catch((cause: unknown) => {
        setError(
          stage === "keys"
            ? t("{{name}} was saved, but its key was not: {{reason}}", {
                name: input.name,
                reason: pluginErrorText(cause, t("Try again.")),
              })
            : pluginErrorText(cause, t("The plugin could not be saved.")),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const setServer = (index: number, patch: Partial<ServerInput>) =>
    setServers((current) =>
      current.map((server, at) => (at === index ? { ...server, ...patch } : server)),
    );
  const setKey = (index: number, at: number, patch: Partial<KeyEntry>) =>
    setKeys((current) => ({
      ...current,
      [index]: (current[index] ?? DEFAULT_KEY).map((entry, position) =>
        position === at ? { ...entry, ...patch } : entry,
      ),
    }));

  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <PageSection title={t("About this plugin")}>
        <div className="flex flex-col gap-4 px-3 py-4 sm:px-4">
          <FormField
            label={t("Name")}
            value={name}
            placeholder={t("Shown to people in their plugins")}
            error={attempted && !input.name ? t("Give it a name.") : null}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descriptionId}>{t("Description")}</Label>
            <Textarea
              id={descriptionId}
              size="sm"
              value={description}
              placeholder={t("What it helps with, in one or two sentences")}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>
          <div className="flex items-end gap-3">
            <PluginIcon contents={contentsKind(input)} icon={icon.trim() || undefined} />
            <FormField
              className="min-w-0 flex-1"
              label={t("Icon address (optional)")}
              inputMode="url"
              placeholder="https://example.com/icon.png"
              value={icon}
              onChange={(event) => setIcon(event.currentTarget.value)}
            />
          </div>
        </div>
      </PageSection>

      <PageSection title={t("Included")} description={includedSummary(input)}>
        {servers.map((server, index) => (
          <ServerFields
            // oxlint-disable-next-line react/no-array-index-key -- servers are never added or removed here.
            key={index}
            server={server}
            title={server.name || hostOf(resolvedUrl(index)) || t("MCP server")}
            resolved={resolvedUrl(index)}
            fills={fills[index] ?? {}}
            signInFix={signInFixes.has(server.name)}
            keys={keyEntries(index)}
            keySaved={
              target.type === "edit" &&
              target.savedKeys.has(server.name) &&
              serverFingerprint(finalServers[index]!) === serverFingerprint(initial.servers[index]!)
            }
            headersChanged={headersChanged(index)}
            keyChanged={
              target.type === "edit" &&
              target.savedKeys.has(server.name) &&
              serverFingerprint(finalServers[index]!) !== serverFingerprint(initial.servers[index]!)
            }
            keyProblem={attempted && keyProblem(index)}
            attempted={attempted}
            disabled={saving}
            onUrl={(url) => setServer(index, { url })}
            onFill={(token, value) =>
              setFills((current) => ({
                ...current,
                [index]: { ...current[index], [token]: value },
              }))
            }
            onCredential={(credential) => setServer(index, { credential })}
            onKey={(at, patch) => setKey(index, at, patch)}
          />
        ))}
        {initial.skills.map((skill) => (
          <PageRow
            key={skill.name}
            leading={
              <RowIcon>
                <BookOpenTextIcon />
              </RowIcon>
            }
          >
            <span className="truncate text-sm text-foreground">{skill.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
          </PageRow>
        ))}
        {servers.length === 0 && initial.skills.length === 0 ? (
          <PageMessage>{t("Nothing usable was found in this plugin.")}</PageMessage>
        ) : null}
      </PageSection>

      {omitted.length > 0 ? (
        <PageSection
          title={t("Not used, and why")}
          description={t("The rest works without these parts.")}
        >
          <div className="px-3 py-4 sm:px-4">
            <NotUsedList omitted={omitted} />
          </div>
        </PageSection>
      ) : null}

      {target.type === "create" ? (
        <PageSection
          title={t("Who can use it")}
          description={
            chosen.value.length === 0
              ? t("No one can use it until you choose a group on its page.")
              : t("People in these groups get it as soon as it is saved.")
          }
        >
          {target.groups ? (
            <GroupChoiceRows
              groups={target.groups}
              value={chosen.value}
              onChange={chosen.onChange}
              disabled={saving || createdId !== null}
              rowClassName="min-h-12 px-3 py-2.5 sm:px-4"
            />
          ) : target.groupsError ? (
            <PageMessage>{target.groupsError}</PageMessage>
          ) : (
            <PageMessage>
              <Spinner size="sm" tone="muted" />
            </PageMessage>
          )}
        </PageSection>
      ) : null}

      <div className="flex flex-col gap-3">
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : attempted && invalid ? (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              {t("Some details are missing. Check the fields marked above.")}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2 px-3 sm:px-4">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => (createdId ? onSaved({ id: createdId, name: input.name }) : onCancel())}
          >
            {createdId ? t("Finish later") : t("Cancel")}
          </Button>
          <Button type="submit" disabled={saving || (target.type === "create" && !target.groups)}>
            {saving ? <Spinner size="sm" /> : null}
            {t("Save plugin")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ServerFields({
  server,
  title,
  resolved,
  fills,
  signInFix,
  keys,
  keySaved,
  keyChanged,
  headersChanged,
  keyProblem,
  attempted,
  disabled,
  onUrl,
  onFill,
  onCredential,
  onKey,
}: {
  readonly server: ServerInput;
  readonly title: string;
  /** The address with the filled-in placeholders. */
  readonly resolved: string;
  readonly fills: Readonly<Record<string, string>>;
  /** The package dropped its sign-in details: the admin confirms how it signs in. */
  readonly signInFix: boolean;
  readonly keys: ReadonlyArray<KeyEntry>;
  readonly keySaved: boolean;
  readonly keyChanged: boolean;
  readonly headersChanged: boolean;
  readonly keyProblem: boolean;
  readonly attempted: boolean;
  readonly disabled: boolean;
  readonly onUrl: (url: string) => void;
  readonly onFill: (token: string, value: string) => void;
  readonly onCredential: (credential: CredentialMode) => void;
  readonly onKey: (at: number, patch: Partial<KeyEntry>) => void;
}) {
  const t = useTranslation();
  const signInId = useId();
  const placeholders = addressPlaceholders(server.url);
  const complete = server.url.trim() !== "" && addressPlaceholders(resolved).length === 0;

  return (
    <div className="flex flex-col gap-4 px-3 py-4 sm:px-4">
      <div className="flex items-center gap-3">
        <RowIcon>
          <PlugIcon />
        </RowIcon>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{title}</span>
          <span className="text-xs text-muted-foreground">{t("Tools from an MCP server")}</span>
        </div>
      </div>
      <div className="flex flex-col gap-4 sm:ps-10">
        <FormField
          label={t("Address")}
          inputMode="url"
          placeholder="https://mcp.example.com/mcp"
          value={server.url}
          disabled={disabled}
          error={attempted && !server.url.trim() ? t("Enter the server's address.") : null}
          hint={
            placeholders.length > 0
              ? complete
                ? t("Baskule will use {{address}}", { address: resolved })
                : t("Fill in the parts in braces below to complete it.")
              : null
          }
          onChange={(event) => onUrl(event.currentTarget.value)}
        />
        {placeholders.map((token) => (
          <FormField
            key={token}
            label={placeholderName(token)}
            value={fills[token] ?? ""}
            disabled={disabled}
            error={
              attempted && !fills[token]?.trim() ? t("Fill this in to complete the address.") : null
            }
            hint={t("Replaces {{token}} in the address.", { token })}
            onChange={(event) => onFill(token, event.currentTarget.value)}
          />
        ))}

        <div className="flex flex-col gap-1.5">
          <Label id={signInId} render={<span />}>
            {t("How it signs in")}
          </Label>
          {signInFix ? (
            <p className="text-xs text-warning-foreground">
              {t("The package didn't include its sign-in details. Check this choice.")}
            </p>
          ) : null}
          <RadioGroup
            aria-labelledby={signInId}
            value={server.credential}
            disabled={disabled}
            onValueChange={(value) => onCredential(value as CredentialMode)}
          >
            <div className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
              {CREDENTIAL_MODES.map((mode) => (
                <label key={mode} className="flex cursor-pointer items-start gap-3 px-3 py-2">
                  <span className="pt-0.5">
                    <Radio value={mode} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{credentialLabel(mode)}</span>
                    <span className="text-xs text-muted-foreground">
                      {credentialDescription(mode)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </div>

        {server.credential === "organization" ? (
          <>
            {keys.map((entry, at) => (
              <FormField
                // oxlint-disable-next-line react/no-array-index-key -- one field per expected header, in order.
                key={at}
                label={keys.length > 1 ? t("Key {{number}}", { number: at + 1 }) : t("Key")}
                type="password"
                autoComplete="new-password"
                placeholder={
                  entry.header.toLowerCase() === "authorization" ? t("Bearer sk-…") : undefined
                }
                value={entry.value}
                disabled={disabled}
                error={keyProblem && !entry.value ? t("Enter this key too.") : null}
                hint={
                  at === keys.length - 1
                    ? headersChanged
                      ? t("The key fields changed. Enter all keys again before saving.")
                      : keyChanged
                        ? t(
                            "The server changed. Enter its key again, or finish setting it up later.",
                          )
                        : keySaved
                          ? t("A key is saved. Leave this empty to keep it.")
                          : t(
                              "Stored encrypted and never shown again. You can also add it later on its page.",
                            )
                    : null
                }
                onChange={(event) => onKey(at, { value: event.currentTarget.value })}
              />
            ))}
            <details className="group text-xs text-muted-foreground">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon aria-hidden className="size-3 group-open:rotate-90" />
                {t("Technical details")}
              </summary>
              <div className="flex flex-col gap-3 pt-3">
                <p>
                  {t(
                    "Each key is sent in a request header. Most services expect “Authorization” with “Bearer” followed by the key.",
                  )}
                </p>
                {keys.map((entry, at) => (
                  <FormField
                    // oxlint-disable-next-line react/no-array-index-key -- one field per key, in order.
                    key={at}
                    label={
                      keys.length > 1
                        ? t("Header for key {{number}}", { number: at + 1 })
                        : t("Header for the key")
                    }
                    autoComplete="off"
                    value={entry.header}
                    disabled={disabled}
                    error={keyProblem && !entry.header.trim() ? t("Enter the header name.") : null}
                    onChange={(event) => onKey(at, { header: event.currentTarget.value })}
                  />
                ))}
              </div>
            </details>
          </>
        ) : null}
      </div>
    </div>
  );
}
