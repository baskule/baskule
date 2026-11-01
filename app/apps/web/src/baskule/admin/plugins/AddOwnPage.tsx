// baskule: Plugins → Add your own: a package (a file or a GitHub link), an MCP server's address or its
// pasted JSON, or a new skill opens the plugin editor. Reading a package saves nothing; only Save in the
// editor does.
import type {
  PluginDraft,
  PluginInspect,
  ServerInput,
  SkillInput,
} from "@t3tools/contracts/baskule-plugins";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenTextIcon } from "lucide-react";
import { useId, useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Spinner } from "../../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { base64Of, pluginErrorText, pluginsApi } from "../../plugins/api";
import { sourceLabel } from "../../plugins/presentation";
import { FormField, notifySuccess, RowIcon, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { PluginEditor } from "./PluginEditor";

/** The ControlCell's upload limit (`IMPORT_LIMITS.archive`). */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

const loadGroups = () => pluginsApi.groups();

/** A plugin made here, of MCP servers or skills; the editor asks for the rest. */
const customDraft = (servers: ServerInput[], skills: SkillInput[] = []): PluginDraft => ({
  plugin: {
    name: "",
    description: "",
    source: { type: "custom" },
    servers,
    skills,
    omitted: [],
  },
  fixes: [],
  omitted: [],
});

type View = "form" | "json";

export function AddOwnPage() {
  const t = useTranslation();
  const navigate = useNavigate();
  const groups = useApiResource(loadGroups);
  const [opened, setOpened] = useState<{ readonly draft: PluginDraft; readonly view: View } | null>(
    null,
  );

  if (!opened) return <AddOwnStart onDraft={(draft, view) => setOpened({ draft, view })} />;
  const { draft } = opened;
  return (
    <>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {draft.plugin.source.type === "custom"
          ? t("Nothing is saved until you click Save plugin.")
          : `${sourceLabel(draft.plugin.source)} · ${t("Nothing is saved until you click Save plugin.")}`}
      </p>
      <PluginEditor
        initial={draft.plugin}
        fixes={draft.fixes}
        omitted={draft.omitted}
        target={{ type: "create", groups: groups.data, groupsError: groups.error }}
        initialView={opened.view}
        onCancel={() => setOpened(null)}
        onSaved={({ id, name, count }) => {
          if (count > 1) {
            notifySuccess(
              t("{{count}} plugin was added", {
                count,
                defaultValue_other: "{{count}} plugins were added",
              }),
            );
            void navigate({
              to: "/admin/$section/$page",
              params: { section: "plugins", page: "installed" },
            });
            return;
          }
          notifySuccess(t("{{name}} was added", { name }));
          void navigate({
            to: "/admin/$section/$page/$item",
            params: { section: "plugins", page: "installed", item: id },
          });
        }}
      />
    </>
  );
}

type Method = "file" | "github";

function AddOwnStart({ onDraft }: { readonly onDraft: (draft: PluginDraft, view: View) => void }) {
  const t = useTranslation();
  const fileId = useId();
  const [method, setMethod] = useState<Method>("file");
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [address, setAddress] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileError =
    file && file.size > MAX_ARCHIVE_BYTES ? t("This file is larger than 10 MB.") : null;
  const ready = method === "file" ? file !== null && !fileError : link.trim() !== "";

  const review = async () => {
    setReading(true);
    setError(null);
    return (async () => {
      const input: PluginInspect =
        method === "file" ? { archive: await base64Of(file!) } : { github: link.trim() };
      onDraft(await pluginsApi.inspect(input), "form");
    })()
      .catch((cause: unknown) => {
        setError(pluginErrorText(cause, t("Baskule couldn't read this plugin.")));
      })
      .finally(() => {
        setReading(false);
      });
  };

  return (
    <>
      <PageSection
        title={t("Import a plugin")}
        description={t(
          "A Claude or Codex plugin, or a folder of skills. You review it before anything is saved.",
        )}
      >
        <form
          className="flex flex-col gap-4 px-3 py-4 sm:px-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !reading) void review();
          }}
        >
          <ToggleGroup
            aria-label={t("Import from")}
            value={[method]}
            onValueChange={(values) => {
              const next = values[0];
              if (next) {
                setMethod(next as Method);
                setError(null);
              }
            }}
          >
            <Toggle value="file">{t("Upload a file")}</Toggle>
            <Toggle value="github">{t("GitHub link")}</Toggle>
          </ToggleGroup>

          {method === "file" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fileId}>{t("Plugin file")}</Label>
              <input
                id={fileId}
                type="file"
                accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
                className="text-sm file:me-3 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-sm file:text-foreground"
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setError(null);
                }}
              />
              <p
                className={
                  fileError
                    ? "text-xs text-destructive-foreground"
                    : "text-xs text-muted-foreground"
                }
              >
                {fileError ?? t("A .zip or .tar.gz, up to 10 MB.")}
              </p>
            </div>
          ) : (
            <FormField
              label={t("GitHub link")}
              inputMode="url"
              placeholder="https://github.com/owner/repository"
              value={link}
              onChange={(event) => {
                setLink(event.currentTarget.value);
                setError(null);
              }}
              hint={t(
                "A public repository, or a branch or folder in one. Baskule keeps the version you review.",
              )}
            />
          )}

          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={!ready || reading}>
              {reading ? <Spinner size="sm" /> : null}
              {t("Review plugin")}
            </Button>
          </div>
        </form>
      </PageSection>

      <PageSection
        title={t("Add an MCP server")}
        description={t(
          "Tools from a server on the web. Enter its address, or paste the settings from its documentation.",
        )}
      >
        <form
          className="flex flex-col gap-4 px-3 py-4 sm:flex-row sm:items-end sm:px-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim())
              onDraft(
                customDraft([
                  {
                    name: "",
                    url: address.trim(),
                    credential: "none",
                    transport: "streamable-http",
                  },
                ]),
                "form",
              );
          }}
        >
          <FormField
            className="min-w-0 flex-1"
            label={t("Server address")}
            inputMode="url"
            placeholder="https://mcp.example.com/mcp"
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="outline" disabled={!address.trim()}>
              {t("Continue")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onDraft(customDraft([]), "json")}>
              {t("Paste JSON")}
            </Button>
          </div>
        </form>
      </PageSection>

      <PageSection title={t("Write a skill")}>
        <PageRow
          leading={
            <RowIcon>
              <BookOpenTextIcon />
            </RowIcon>
          }
          trailing={
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onDraft(
                  customDraft([], [{ name: "", description: "", instructions: "", files: [] }]),
                  "form",
                )
              }
            >
              {t("New skill")}
            </Button>
          }
        >
          <span className="text-sm text-foreground">
            {t("Steps the assistant follows for one kind of task, with any files they need.")}
          </span>
        </PageRow>
      </PageSection>
    </>
  );
}
