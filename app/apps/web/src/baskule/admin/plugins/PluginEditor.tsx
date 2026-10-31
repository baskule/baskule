// baskule: the one editor for a plugin an admin brings: the review of an import before it is saved,
// MCP servers entered as a form or pasted as JSON, skills, and later edits. Nothing is saved until
// Save, except Revert, which restores earlier skills at once; a server's test only reads its tools.
// Entered keys are written after the plugin itself, through the write-only key route.
import {
  addressPlaceholders,
  parseServersJson,
  serverFingerprint,
  serversJson,
  type ParsedServers,
} from "@t3tools/contracts/baskule-plugin-formats";
import type {
  CredentialMode,
  Fix,
  Group,
  Omission,
  PluginInput,
  PluginTool,
  ServerInput,
  SkillHistory,
  SkillInput,
} from "@t3tools/contracts/baskule-plugins";
import { BookOpenTextIcon, ChevronRightIcon, PlugIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Radio, RadioGroup } from "../../../components/ui/radio-group";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { base64Of, pluginErrorText, pluginsApi, toolsErrorText } from "../../plugins/api";
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
import { confirmAction, FormField, RowIcon } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { ServerTools } from "./ServerTools";
import { SkillEditor, skillInvalid, SkillVersions, type RevertState } from "./SkillEditor";

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
      readonly versions: SkillHistory["versions"];
    };

interface KeyEntry {
  readonly header: string;
  readonly value: string;
}

type TestOutcome =
  | { readonly tools: ReadonlyArray<PluginTool> }
  | { readonly signIn: "account"; readonly staticClient: boolean }
  | { readonly error: string };

/** One server as the admin edits it. */
interface ServerRow {
  /** Stable through renames and JSON edits: the React key, and the plugin a split save made for it. */
  readonly key: string;
  /** The saved server this row edits, by the name it was saved under. */
  readonly origin: string | null;
  /** The server as it was when its organization key was saved, if one is. */
  readonly savedKey: ServerInput | null;
  readonly server: ServerInput;
  readonly fills: Readonly<Record<string, string>>;
  readonly keys: ReadonlyArray<KeyEntry>;
  /** A result is shown only while the settings still match `signature`; `run` tells tests apart. */
  readonly test: {
    readonly signature: string;
    readonly run: object;
    readonly outcome: TestOutcome | null;
  } | null;
  /** Test was pressed with details missing. */
  readonly checked: boolean;
}

let rowCount = 0;
const newRow = (
  server: ServerInput,
  origin: string | null,
  headers?: ReadonlyArray<string>,
): ServerRow => ({
  key: `server-${rowCount++}`,
  origin,
  savedKey: null,
  server,
  fills: {},
  keys: (headers?.length
    ? headers
    : server.keyHeaders?.length
      ? server.keyHeaders
      : ["Authorization"]
  ).map((header) => ({ header, value: "" })),
  test: null,
  checked: false,
});

interface SkillRow {
  /** Stable through renames: the React key and what is open. */
  readonly key: string;
  readonly skill: SkillInput;
}

let skillCount = 0;
const newSkillRow = (skill: SkillInput): SkillRow => ({ key: `skill-${skillCount++}`, skill });
const NEW_SKILL: SkillInput = { name: "", description: "", instructions: "", files: [] };

const NO_SERVERS: ParsedServers = { servers: [], secrets: {}, fixes: [], omitted: [] };
const parseJson = (text: string) => (text.trim() ? parseServersJson(text) : NO_SERVERS);

const JSON_EXAMPLE = `{
  "mcpServers": {
    "notes": { "url": "https://mcp.example.com/mcp" }
  }
}`;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** `{tenant}` and `${TENANT}` are shown to people as `tenant` and `TENANT`. */
const placeholderName = (token: string) => token.replace(/^\$?\{|\}$/g, "");

const resolvedUrl = (row: ServerRow) =>
  addressPlaceholders(row.server.url).reduce((url, token) => {
    const value = row.fills[token]?.trim();
    return value ? url.split(token).join(value) : url;
  }, row.server.url.trim());

/** The server as it is saved and tested. */
function finalServer(row: ServerRow): ServerInput {
  const url = resolvedUrl(row);
  const { oauth, keyHeaders: _keyHeaders, ...rest } = row.server;
  return {
    ...rest,
    ...(row.server.credential === "user-oauth" && oauth ? { oauth } : {}),
    ...(row.server.credential === "organization"
      ? { keyHeaders: row.keys.map((entry) => entry.header.trim()) }
      : {}),
    name: row.server.name.trim() || hostOf(url) || "server",
    url,
  };
}

const headerValues = (row: ServerRow) =>
  Object.fromEntries(row.keys.map((entry) => [entry.header.trim(), entry.value]));

export function PluginEditor({
  initial,
  fixes,
  omitted,
  target,
  initialView = "form",
  onCancel,
  onSaved,
  onReverted,
}: {
  readonly initial: PluginInput;
  /** What the import found to fix in place: sign-in, address placeholders, keys. */
  readonly fixes: ReadonlyArray<Fix>;
  readonly omitted: ReadonlyArray<Omission>;
  readonly target: EditorTarget;
  readonly initialView?: "form" | "json";
  readonly onCancel: () => void;
  /** `count` plugins were saved; `id` and `name` are the last one's. */
  readonly onSaved: (saved: {
    readonly id: string;
    readonly name: string;
    readonly count: number;
  }) => void;
  /** Revert saved earlier skills: what the page shows of the plugin is out of date. */
  readonly onReverted?: () => void;
}) {
  const t = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [icon, setIcon] = useState(initial.icon ?? "");
  const [rows, setRows] = useState<ReadonlyArray<ServerRow>>(() =>
    initial.servers.map((server) => {
      const fix = fixes.find((entry) => entry.server === server.name && entry.need === "key");
      return {
        ...newRow(
          server,
          target.type === "edit" ? server.name : null,
          fix?.need === "key" ? fix.headers : undefined,
        ),
        savedKey: target.type === "edit" && target.savedKeys.has(server.name) ? server : null,
      };
    }),
  );
  const [skills, setSkills] = useState(() => initial.skills.map(newSkillRow));
  const [openSkills, setOpenSkills] = useState<ReadonlySet<string>>(
    () => new Set(skills.filter((row) => !row.skill.name).map((row) => row.key)),
  );
  // Revert replaces the skills shown here, so unsaved skill edits are confirmed first.
  const [skillsEdited, setSkillsEdited] = useState(false);
  const [versions, setVersions] = useState(target.type === "edit" ? target.versions : []);
  const [reverted, setReverted] = useState<RevertState>(null);
  const [view, setView] = useState(initialView);
  const [json, setJson] = useState(() =>
    initialView === "json" && initial.servers.length ? serversJson(initial.servers) : "",
  );
  // Entries pasted JSON described that Baskule can't run, kept after the text is rewritten.
  const [jsonOmitted, setJsonOmitted] = useState<ReadonlyArray<Omission>>([]);
  // Servers the JSON stopped describing while it is edited, such as one whose name is being retyped.
  const [jsonRows, setJsonRows] = useState<ReadonlyArray<ServerRow>>([]);
  const [splitChosen, setSplitChosen] = useState(false);
  const chosen = useGroupChoice(target.type === "create" ? target.groups : null);
  // Plugins already created, by save unit, so a retry updates them instead of adding them twice.
  const [created, setCreated] = useState<Readonly<Record<string, string>>>({});
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const jsonHintId = useId();

  const signInFixes = new Set(
    fixes.filter((fix) => fix.need === "sign_in").map((fix) => fix.server),
  );
  const finals = rows.map(finalServer);
  const canSplit =
    target.type === "create" &&
    initial.source.type === "custom" &&
    skills.length === 0 &&
    rows.length > 1;
  const split = canSplit && splitChosen;
  const createdIds = Object.entries(created);
  // Once some of the separate plugins exist, each server stays tied to the plugin made for it.
  const frozen = split && createdIds.length > 0;
  const parsedJson = view === "json" ? parseJson(json) : null;
  const jsonInvalid = parsedJson !== null && "error" in parsedJson;
  // Pinned GitHub skills change only through a copy once saved; an import is still the admin's to edit.
  const skillsEditable =
    (target.type === "create" && !created.plugin) ||
    initial.source.type === "custom" ||
    initial.source.type === "upload";
  const otherNames = (key: string) =>
    skills.filter((row) => row.key !== key).map((row) => row.skill.name);
  const invalidSkills = skillsEditable
    ? skills.filter((row) => skillInvalid(row.skill, otherNames(row.key)))
    : [];
  const onlySkill =
    target.type === "create" && rows.length === 0 && skills.length === 1 ? skills[0]!.skill : null;
  const reverting = reverted !== null && "done" in reverted && !reverted.done;
  const canAddSkill = skillsEditable && !split;

  const prior = (row: ServerRow) => initial.servers.find((server) => server.name === row.origin);
  /** Switches left as they were loaded aren't sent, so the save keeps any changed since. */
  const sent = (row: ServerRow, server: ServerInput): ServerInput => {
    const before = prior(row);
    const off = server.disabledTools ?? [];
    const loaded = before?.disabledTools ?? [];
    if (
      target.type !== "edit" ||
      !before ||
      before.name !== server.name ||
      before.url !== server.url ||
      off.length !== loaded.length ||
      off.some((tool) => !loaded.includes(tool))
    ) {
      return server;
    }
    const { disabledTools: _unchanged, ...rest } = server;
    return rest;
  };

  const input: PluginInput = {
    name: name.trim() || onlySkill?.name || "",
    description: description.trim() || onlySkill?.description.trim() || "",
    ...(icon.trim() ? { icon: icon.trim() } : {}),
    source: initial.source,
    servers: rows.map((row, index) => sent(row, finals[index]!)),
    skills: skills.map((row) => row.skill),
    omitted: initial.omitted,
  };
  const units = split
    ? rows.map((row, index) => ({
        key: row.key,
        rows: [row],
        input: {
          name: finals[index]!.name,
          description: "",
          source: initial.source,
          servers: [finals[index]!],
          skills: [],
          omitted: [],
        } satisfies PluginInput,
      }))
    : [{ key: "plugin", rows, input }];

  const keySavedFor = (row: ServerRow) => row.savedKey !== null;
  const sameBinding = (row: ServerRow, before: ServerInput | null = prior(row) ?? null) => {
    const after = finalServer(row);
    return (
      before !== null &&
      before.name === after.name &&
      serverFingerprint(before) === serverFingerprint(after)
    );
  };
  const headersChanged = (row: ServerRow) =>
    keySavedFor(row) &&
    JSON.stringify(row.keys.map((entry) => entry.header.trim())) !==
      JSON.stringify(row.savedKey?.keyHeaders ?? ["Authorization"]);
  const keyProblem = (row: ServerRow) => {
    const filled = row.keys.filter((entry) => entry.value !== "").length;
    return (
      (filled > 0 || headersChanged(row)) &&
      (filled < row.keys.length || row.keys.some((entry) => !entry.header.trim()))
    );
  };
  const addressProblem = (row: ServerRow) =>
    !row.server.url.trim() || addressPlaceholders(resolvedUrl(row)).length > 0;
  /** An unchanged saved server with no new key lists its tools with what is saved for it. */
  const listsSaved = (row: ServerRow) =>
    target.type === "edit" &&
    sameBinding(row) &&
    !headersChanged(row) &&
    row.keys.every((entry) => entry.value === "") &&
    (row.server.credential !== "organization" || sameBinding(row, row.savedKey));
  const testKeyMissing = (row: ServerRow) =>
    row.server.credential === "organization" &&
    !listsSaved(row) &&
    row.keys.some((entry) => !entry.value || !entry.header.trim());
  const signature = (row: ServerRow) => {
    const { disabledTools: _off, name: _name, ...server } = finalServer(row);
    return JSON.stringify([
      server,
      row.server.credential === "organization" ? row.keys : null,
      listsSaved(row) ? row.origin : null,
    ]);
  };
  const nameTaken = (index: number) =>
    finals.some((server, at) => at !== index && server.name === finals[index]!.name);
  const duplicateNames = finals.some((_, index) => nameTaken(index));
  const testing = rows.some(
    (row) => row.test?.signature === signature(row) && row.test.outcome === null,
  );
  const invalid =
    jsonInvalid ||
    (!split && !input.name) ||
    (rows.length === 0 && skills.length === 0) ||
    invalidSkills.length > 0 ||
    duplicateNames ||
    rows.some(
      (row) => addressProblem(row) || (row.server.credential === "organization" && keyProblem(row)),
    );

  const updateRow = (key: string, change: (row: ServerRow) => ServerRow) =>
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
  const updateSkill = (key: string, change: (skill: SkillInput) => SkillInput) => {
    setSkillsEdited(true);
    setSkills((current) =>
      current.map((row) => (row.key === key ? { ...row, skill: change(row.skill) } : row)),
    );
  };
  const addFiles = (key: string, files: ReadonlyArray<File>) => {
    if (!files.length || readingFiles) return;
    setReadingFiles(true);
    setSkillsEdited(true);
    setError(null);
    void Promise.all(
      files.map(async (file) => ({
        path: file.name,
        content: await base64Of(file),
        encoding: "base64" as const,
      })),
    )
      .then((added) =>
        updateSkill(key, (skill) => ({ ...skill, files: [...skill.files, ...added] })),
      )
      .catch(() => setError(t("The files could not be read. Add them again.")))
      .finally(() => setReadingFiles(false));
  };
  const toggleSkill = (key: string) =>
    setOpenSkills((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const addSkill = () => {
    const row = newSkillRow(NEW_SKILL);
    setSkillsEdited(true);
    setSkills((current) => [...current, row]);
    setOpenSkills((current) => new Set(current).add(row.key));
  };

  const revert = async (version: number) => {
    if (target.type !== "edit" || readingFiles) return;
    if (
      skillsEdited &&
      !(await confirmAction(
        t(
          "Revert to version {{version}}?\nThe skill changes you haven't saved are replaced by that version. Other changes on this page stay.",
          { version },
        ),
      ))
    )
      return;
    setReverted({ version, done: false });
    return pluginsApi.revert(target.id, version).then(
      (history) => {
        setSkills(history.skills.map(newSkillRow));
        setOpenSkills(new Set());
        setSkillsEdited(false);
        setVersions(history.versions);
        setReverted({ version, done: true });
        onReverted?.();
      },
      (cause: unknown) =>
        setReverted({
          error: pluginErrorText(cause, t("The skills could not be restored. Try again.")),
        }),
    );
  };

  const test = (row: ServerRow) => {
    if (addressProblem(row) || testKeyMissing(row)) {
      updateRow(row.key, (current) => ({ ...current, checked: true }));
      return;
    }
    const run = {};
    const requested = signature(row);
    updateRow(row.key, (current) => ({
      ...current,
      checked: false,
      test: { signature: requested, run, outcome: null },
    }));
    const server = finalServer(row);
    const listing: Promise<TestOutcome> =
      target.type === "edit" && listsSaved(row)
        ? pluginsApi.tools(target.id, server.name).then(
            (tools) => ({ tools }),
            (cause: unknown) => ({ error: toolsErrorText(cause) }),
          )
        : pluginsApi
            .test({
              server,
              ...(server.credential === "organization" ? { headers: headerValues(row) } : {}),
            })
            .catch((cause: unknown) => ({
              error: pluginErrorText(cause, t("Check the server details and try again.")),
            }));
    void listing.then((outcome) => {
      const finish = (current: ReadonlyArray<ServerRow>) =>
        current.map((entry) => {
          if (entry.key !== row.key || entry.test?.run !== run) return entry;
          if (!("signIn" in outcome) || signature(entry) !== requested) {
            return { ...entry, test: { signature: requested, run, outcome } };
          }
          // The server asks each person to sign in: that is how it signs in from now on.
          const { oauth, ...rest } = entry.server;
          const { staticClient: _staticClient, ...recipe } = oauth ?? {};
          const next = outcome.staticClient ? { ...recipe, staticClient: true as const } : recipe;
          const signedIn: ServerRow = {
            ...entry,
            server: {
              ...rest,
              credential: "user-oauth",
              ...(Object.keys(next).length ? { oauth: next } : {}),
            },
          };
          return { ...signedIn, test: { signature: signature(signedIn), run, outcome } };
        });
      // A server left out of the JSON while it is edited keeps the result for when it comes back.
      setRows(finish);
      setJsonRows(finish);
    });
  };

  const showJson = () => {
    setJson(rows.length ? serversJson(finals) : "");
    setView("json");
  };
  /** Pasted servers replace the form's. What was typed for a server stays with it, even through edits
   * that briefly leave it out: matched by name, or by its address while it is being renamed. The
   * form's servers match first; one left out comes back only at its own address. */
  const editJson = (text: string) => {
    const parsed = parseJson(text);
    if ("error" in parsed) {
      setJson(text);
      return;
    }
    const known = [...rows, ...jsonRows];
    const matched = new Set<string>();
    setRows(
      parsed.servers.map((server) => {
        const at = (row: ServerRow) => !matched.has(row.key) && server.url === finalServer(row).url;
        const renamed = (row: ServerRow) =>
          at(row) && !parsed.servers.some((entry) => entry.name === finalServer(row).name);
        const before =
          rows.find((row) => finalServer(row).name === server.name) ??
          rows.find(renamed) ??
          jsonRows.find((row) => at(row) && finalServer(row).name === server.name) ??
          jsonRows.find(renamed);
        if (before) matched.add(before.key);
        const saved =
          target.type === "edit"
            ? initial.servers.find(
                (entry) => entry.name === server.name && entry.url === server.url,
              )
            : undefined;
        const typed = parsed.secrets[server.name] ?? {};
        const recipe = [before?.server, saved].find(
          (entry) => entry?.credential === "user-oauth" && entry.oauth,
        )?.oauth;
        const disabledTools = before?.server.disabledTools ?? saved?.disabledTools;
        const row = newRow(
          {
            ...server,
            ...(server.credential === "user-oauth" && recipe ? { oauth: recipe } : {}),
            ...(disabledTools ? { disabledTools } : {}),
          },
          before ? before.origin : (saved?.name ?? null),
        );
        return {
          ...row,
          key: before?.key ?? row.key,
          savedKey: before
            ? before.savedKey
            : saved && target.type === "edit" && target.savedKeys.has(saved.name)
              ? saved
              : null,
          fills: before?.fills ?? {},
          test: before?.test ?? null,
          keys:
            server.credential === "organization"
              ? row.keys.map(({ header }) => ({
                  header,
                  value:
                    typed[header] ??
                    before?.keys.find((entry) => entry.header.trim() === header)?.value ??
                    "",
                }))
              : (before?.keys ?? row.keys),
        };
      }),
    );
    setJsonRows(known.filter((row) => !matched.has(row.key)));
    setJsonOmitted((current) =>
      [...current, ...parsed.omitted].filter(
        (entry, index, all) =>
          !parsed.servers.some((server) => server.name === entry.subject) &&
          all.findIndex((other) => other.subject === entry.subject) === index,
      ),
    );
    // Keys never stay in the text: they move to the key fields and the text shows placeholders.
    setJson(Object.keys(parsed.secrets).length ? serversJson(parsed.servers) : text);
  };

  const save = async () => {
    setAttempted(true);
    if (invalidSkills.length > 0)
      setOpenSkills((current) => new Set([...current, ...invalidSkills.map((row) => row.key)]));
    if (invalid || saving || testing || reverting || readingFiles) return;
    setSaving(true);
    setError(null);
    const ids = { ...created };
    const finished = new Set(done);
    let failure = { name: input.name, stage: "plugin" as "plugin" | "keys" };
    return (async () => {
      let last = { id: "", name: input.name };
      for (const unit of units) {
        let id = target.type === "edit" ? target.id : ids[unit.key];
        if (!finished.has(unit.key)) {
          failure = { name: unit.input.name, stage: "plugin" };
          if (id) await pluginsApi.update(id, { plugin: unit.input });
          else {
            id = (await pluginsApi.create({ plugin: unit.input, groups: [...chosen.value] })).id;
            ids[unit.key] = id;
            setCreated({ ...ids });
          }
          failure = { name: unit.input.name, stage: "keys" };
          for (const [at, row] of unit.rows.entries()) {
            const server = unit.input.servers[at]!;
            if (server.credential !== "organization") continue;
            if (row.keys.every((entry) => entry.value === "")) continue;
            await pluginsApi.secret(id, { server: server.name, headers: headerValues(row) });
            // Saved: a retry keeps it instead of sending it again. A test's signature holds keys too.
            updateRow(row.key, (current) => ({
              ...current,
              savedKey: server,
              keys: current.keys.map((entry) => ({ ...entry, value: "" })),
              test: null,
            }));
          }
          finished.add(unit.key);
          setDone(new Set(finished));
        }
        last = { id: id!, name: unit.input.name };
      }
      onSaved({ ...last, count: units.length });
    })()
      .catch((cause: unknown) => {
        setError(
          failure.stage === "keys"
            ? t("{{name}} was saved, but its key was not: {{reason}}", {
                name: failure.name,
                reason: pluginErrorText(cause, t("Try again.")),
              })
            : pluginErrorText(cause, t("The plugin could not be saved.")),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };
  const finishLater = () => {
    const [key, id] = createdIds.at(-1)!;
    onSaved({
      id,
      name: units.find((unit) => unit.key === key)?.input.name ?? input.name,
      count: createdIds.length,
    });
  };

  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {canSplit ? (
        <PageSection
          title={t("Add as")}
          description={t("These settings describe {{count}} servers.", { count: rows.length })}
        >
          <RadioGroup
            aria-label={t("Add as")}
            value={split ? "separate" : "one"}
            disabled={saving || createdIds.length > 0}
            onValueChange={(value) => setSplitChosen(value === "separate")}
          >
            <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50">
              {(
                [
                  ["one", t("One plugin"), t("People get all of its servers in one plugin.")],
                  [
                    "separate",
                    t("Separate plugins"),
                    t(
                      "Each server becomes its own plugin, named after the server. You can rename each on its page.",
                    ),
                  ],
                ] as const
              ).map(([value, label, detail]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-3 px-3 py-2.5 sm:px-4"
                >
                  <span className="pt-0.5">
                    <Radio value={value} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{label}</span>
                    <span className="text-xs text-muted-foreground">{detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </PageSection>
      ) : null}

      {split ? null : (
        <PageSection title={t("About this plugin")}>
          <div className="flex flex-col gap-4 px-3 py-4 sm:px-4">
            <FormField
              label={t("Name")}
              value={name}
              placeholder={onlySkill?.name || t("Shown to people in their plugins")}
              error={attempted && !input.name ? t("Give it a name.") : null}
              hint={onlySkill ? t("Leave empty to use the skill's name and description.") : null}
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
      )}

      <PageSection
        title={t("Included")}
        description={rows.length > 0 || skills.length > 0 ? includedSummary(input) : undefined}
        action={
          <ToggleGroup
            aria-label={t("Server settings")}
            value={[view]}
            onValueChange={(values) => {
              if (values[0] === "json" && view !== "json") showJson();
              if (values[0] === "form") {
                setView("form");
                setJsonRows([]);
              }
            }}
          >
            <Toggle value="form" disabled={jsonInvalid}>
              {t("Form")}
            </Toggle>
            <Toggle value="json">{t("JSON")}</Toggle>
          </ToggleGroup>
        }
      >
        {view === "json" ? (
          <div className="flex flex-col gap-1.5 px-3 py-4 sm:px-4">
            <Textarea
              aria-label={t("Server settings as JSON")}
              aria-invalid={jsonInvalid || undefined}
              aria-describedby={jsonHintId}
              spellCheck={false}
              autoComplete="off"
              placeholder={JSON_EXAMPLE}
              value={json}
              disabled={saving}
              readOnly={frozen}
              onChange={(event) => editJson(event.currentTarget.value)}
            />
            <p
              id={jsonHintId}
              className={
                jsonInvalid
                  ? "text-xs text-destructive-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              {jsonInvalid
                ? t("This JSON could not be read. Use an mcpServers or servers object.")
                : t(
                    "Paste the server settings from Claude, Cursor, VS Code or a .mcp.json file. Keys in it move to encrypted fields.",
                  )}
            </p>
          </div>
        ) : (
          <>
            {rows.map((row, index) => {
              const shown = row.test?.signature === signature(row) ? row.test : null;
              return (
                <ServerFields
                  key={row.key}
                  row={row}
                  title={row.server.name.trim() || hostOf(resolvedUrl(row)) || t("MCP server")}
                  resolved={resolvedUrl(row)}
                  signInFix={signInFixes.has(finals[index]!.name)}
                  keySaved={keySavedFor(row) && sameBinding(row, row.savedKey)}
                  keyChanged={keySavedFor(row) && !sameBinding(row, row.savedKey)}
                  headersChanged={headersChanged(row)}
                  keyProblem={
                    (attempted && keyProblem(row)) || (row.checked && testKeyMissing(row))
                  }
                  showErrors={attempted || row.checked}
                  nameTaken={nameTaken(index)}
                  disabled={saving || done.has(row.key)}
                  removable={!frozen && (rows.length > 1 || skills.length > 0)}
                  testing={shown !== null && shown.outcome === null}
                  outcome={shown?.outcome ?? null}
                  onChange={(change) => updateRow(row.key, change)}
                  onRemove={() =>
                    setRows((current) => current.filter((entry) => entry.key !== row.key))
                  }
                  onTest={() => test(row)}
                />
              );
            })}
          </>
        )}
        {skills.map((row) =>
          skillsEditable ? (
            <SkillEditor
              key={row.key}
              skill={row.skill}
              otherNames={otherNames(row.key)}
              open={openSkills.has(row.key)}
              showErrors={attempted}
              disabled={saving || reverting || readingFiles}
              removable={!frozen && (rows.length > 0 || skills.length > 1)}
              onToggle={() => toggleSkill(row.key)}
              onChange={(change) => updateSkill(row.key, change)}
              onAddFiles={(files) => addFiles(row.key, files)}
              onRemove={() => {
                setSkillsEdited(true);
                setSkills((current) => current.filter((entry) => entry.key !== row.key));
              }}
            />
          ) : (
            <PageRow
              key={row.key}
              leading={
                <RowIcon>
                  <BookOpenTextIcon />
                </RowIcon>
              }
            >
              <span className="truncate text-sm text-foreground">{row.skill.name}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {row.skill.description}
              </span>
            </PageRow>
          ),
        )}
        {!skillsEditable && skills.length > 0 ? (
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            {t(
              "These skills stay as published. To change them, make your own copy from the plugin's page.",
            )}
          </p>
        ) : null}
        {view === "form" && rows.length === 0 && skills.length === 0 ? (
          <PageMessage>{t("Nothing usable was found in this plugin.")}</PageMessage>
        ) : null}
        {frozen || (view === "json" && !canAddSkill) ? null : (
          <div className="flex flex-wrap gap-2 px-3 py-2.5 sm:px-4">
            {view === "form" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    newRow(
                      { name: "", url: "", credential: "none", transport: "streamable-http" },
                      null,
                    ),
                  ])
                }
              >
                <PlusIcon />
                {t("Add a server")}
              </Button>
            ) : null}
            {canAddSkill ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving || reverting || readingFiles}
                onClick={addSkill}
              >
                <PlusIcon />
                {t("Add a skill")}
              </Button>
            ) : null}
          </div>
        )}
      </PageSection>

      {target.type === "edit" && skillsEditable && versions.length > 0 ? (
        <SkillVersions
          versions={versions}
          state={reverted}
          disabled={saving || readingFiles}
          onRevert={(version) => void revert(version)}
        />
      ) : null}

      {omitted.length > 0 || jsonOmitted.length > 0 ? (
        <PageSection title={t("Not used, and why")}>
          <div className="px-3 py-4 sm:px-4">
            <NotUsedList omitted={[...omitted, ...jsonOmitted]} />
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
              disabled={saving || createdIds.length > 0}
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
        {readingFiles ? (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            {t("Reading files…")}
          </p>
        ) : null}
        {split && createdIds.length > 0 ? (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            {t("{{saved}} of {{count}} plugins are ready. Save again to finish the rest.", {
              saved: done.size,
              count: units.length,
            })}
          </p>
        ) : null}
        {error ? (
          <Alert variant="error" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : attempted && invalid ? (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              {jsonInvalid
                ? t("Fix the JSON before saving.")
                : duplicateNames
                  ? t("Two servers have the same name. Change one under Technical details.")
                  : t("Some details are missing. Check the fields marked above.")}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2 px-3 sm:px-4">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => (createdIds.length > 0 ? finishLater() : onCancel())}
          >
            {createdIds.length > 0 ? t("Finish later") : t("Cancel")}
          </Button>
          <Button
            type="submit"
            disabled={
              saving ||
              testing ||
              reverting ||
              readingFiles ||
              (target.type === "create" && !target.groups)
            }
          >
            {saving ? <Spinner size="sm" /> : null}
            {split ? t("Save plugins") : t("Save plugin")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ServerFields({
  row,
  title,
  resolved,
  signInFix,
  keySaved,
  keyChanged,
  headersChanged,
  keyProblem,
  showErrors,
  nameTaken,
  disabled,
  removable,
  testing,
  outcome,
  onChange,
  onRemove,
  onTest,
}: {
  readonly row: ServerRow;
  readonly title: string;
  /** The address with the filled-in placeholders. */
  readonly resolved: string;
  /** The package dropped its sign-in details: the admin confirms how it signs in. */
  readonly signInFix: boolean;
  readonly keySaved: boolean;
  readonly keyChanged: boolean;
  readonly headersChanged: boolean;
  readonly keyProblem: boolean;
  readonly showErrors: boolean;
  readonly nameTaken: boolean;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly testing: boolean;
  /** The last test's result, only while it still matches the settings. */
  readonly outcome: TestOutcome | null;
  readonly onChange: (change: (row: ServerRow) => ServerRow) => void;
  readonly onRemove: () => void;
  readonly onTest: () => void;
}) {
  const t = useTranslation();
  const signInId = useId();
  const { server, fills, keys } = row;
  const placeholders = addressPlaceholders(server.url);
  const complete = server.url.trim() !== "" && addressPlaceholders(resolved).length === 0;
  const setServer = (patch: Partial<ServerInput>) =>
    onChange((current) => ({ ...current, server: { ...current.server, ...patch } }));
  const setKeys = (change: (keys: ReadonlyArray<KeyEntry>) => ReadonlyArray<KeyEntry>) =>
    onChange((current) => ({ ...current, keys: change(current.keys) }));
  const setKey = (at: number, patch: Partial<KeyEntry>) =>
    setKeys((current) =>
      current.map((entry, position) => (position === at ? { ...entry, ...patch } : entry)),
    );
  const setAllowed = (tool: string, allowed: boolean) =>
    onChange((current) => {
      const off = (current.server.disabledTools ?? []).filter((entry) => entry !== tool);
      return {
        ...current,
        server: { ...current.server, disabledTools: allowed ? off : [...off, tool] },
      };
    });

  return (
    <div role="group" aria-label={title} className="flex flex-col gap-4 px-3 py-4 sm:px-4">
      <div className="flex items-center gap-3">
        <RowIcon>
          <PlugIcon />
        </RowIcon>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
        {removable ? (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
            {t("Remove server")}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-4 sm:ps-10">
        <FormField
          label={t("Address")}
          inputMode="url"
          placeholder="https://mcp.example.com/mcp"
          value={server.url}
          disabled={disabled}
          error={showErrors && !server.url.trim() ? t("Enter the server's address.") : null}
          hint={
            placeholders.length > 0
              ? complete
                ? t("Baskule will use {{address}}", { address: resolved })
                : t("Fill in the parts in braces below to complete it.")
              : null
          }
          onChange={(event) => setServer({ url: event.currentTarget.value })}
        />
        {placeholders.map((token) => (
          <FormField
            key={token}
            label={placeholderName(token)}
            value={fills[token] ?? ""}
            disabled={disabled}
            error={
              showErrors && !fills[token]?.trim()
                ? t("Fill this in to complete the address.")
                : null
            }
            hint={t("Replaces {{token}} in the address.", { token })}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange((current) => ({ ...current, fills: { ...current.fills, [token]: value } }));
            }}
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
            onValueChange={(value) => setServer({ credential: value as CredentialMode })}
          >
            <div className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
              {CREDENTIAL_MODES.map((mode) => (
                <label key={mode} className="flex cursor-pointer items-start gap-3 px-3 py-2">
                  <span className="pt-0.5">
                    <Radio value={mode} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{credentialLabel(mode)}</span>
                    {server.credential === mode ? (
                      <span className="text-xs text-muted-foreground">
                        {credentialDescription(mode)}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </div>

        {server.credential === "organization"
          ? keys.map((entry, at) => (
              <FormField
                // oxlint-disable-next-line react/no-array-index-key -- controlled fields, one per header in order.
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
                onChange={(event) => setKey(at, { value: event.currentTarget.value })}
              />
            ))
          : null}

        <details className="group text-xs text-muted-foreground">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden className="size-3 group-open:rotate-90" />
            {t("Technical details")}
          </summary>
          <div className="flex flex-col gap-3 pt-3">
            <FormField
              label={t("Server name")}
              autoComplete="off"
              placeholder={hostOf(resolved) || undefined}
              value={server.name}
              disabled={disabled}
              error={nameTaken ? t("Another server has this name.") : null}
              onChange={(event) => setServer({ name: event.currentTarget.value })}
            />
            {server.credential === "organization" ? (
              <>
                <p>
                  {t(
                    "Each key is sent in a request header. Most services expect “Authorization” with “Bearer” followed by the key.",
                  )}
                </p>
                {keys.map((entry, at) => (
                  // oxlint-disable-next-line react/no-array-index-key -- controlled fields, one per header in order.
                  <div key={at} className="flex items-end gap-2">
                    <FormField
                      className="min-w-0 flex-1"
                      label={
                        keys.length > 1
                          ? t("Header for key {{number}}", { number: at + 1 })
                          : t("Header for the key")
                      }
                      autoComplete="off"
                      value={entry.header}
                      disabled={disabled}
                      error={
                        keyProblem && !entry.header.trim() ? t("Enter the header name.") : null
                      }
                      onChange={(event) => setKey(at, { header: event.currentTarget.value })}
                    />
                    {keys.length > 1 ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={t("Remove key {{number}}", { number: at + 1 })}
                        disabled={disabled}
                        onClick={() =>
                          setKeys((current) => current.filter((_, position) => position !== at))
                        }
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setKeys((current) => [...current, { header: "", value: "" }])}
                  >
                    <PlusIcon />
                    {t("Add a key")}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </details>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || testing}
              onClick={onTest}
            >
              {testing ? <Spinner size="sm" /> : null}
              {testing ? t("Testing…") : t("Test connection")}
            </Button>
            {outcome === null && !testing ? (
              <span className="text-xs text-muted-foreground">
                {t("Optional: see its tools and switch off any you don't want.")}
              </span>
            ) : null}
          </div>
          {outcome === null ? null : "tools" in outcome ? (
            <ServerTools
              tools={outcome.tools}
              disabledTools={server.disabledTools ?? []}
              disabled={disabled}
              onAllowed={setAllowed}
            />
          ) : "signIn" in outcome ? (
            <div role="status" className="flex flex-col gap-1 text-xs text-muted-foreground">
              <p>{t("People connect their own account after this plugin is saved.")}</p>
              {outcome.staticClient ? (
                <p>
                  {t(
                    "Your administrator needs to register this service before people can connect.",
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {outcome.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
