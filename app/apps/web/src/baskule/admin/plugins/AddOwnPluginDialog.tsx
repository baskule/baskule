// baskule: add a plugin that no registry lists: a connector by its address, skills or a bundle
// from a git repository at a fixed commit, or an uploaded .zip / .tar.gz.
import type { Group, Plugin, PluginInstallInput } from "@t3tools/contracts/baskule-plugins";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Label } from "../../../components/ui/label";
import { Spinner } from "../../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { pluginErrorText, pluginsApi } from "../../plugins/api";
import { PluginGroupsField, useGroupChoice } from "../../plugins/PluginParts";
import { FormField } from "../../ui";

type Method = "address" | "git" | "file";

/** The ControlCell's upload limit (`IMPORT_LIMITS.archive`). */
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/i;

type InstallSource = Pick<PluginInstallInput, "source" | "archive">;

async function archiveInput(file: File): Promise<InstallSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { source: { type: "archive", sha256 }, archive: btoa(binary) };
}

export function AddOwnPluginDialog({
  open,
  onOpenChange,
  onAdded,
  groups,
  groupsError,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdded: (plugin: Plugin, groups: ReadonlyArray<string>) => void;
  readonly groups: ReadonlyArray<Group> | null;
  readonly groupsError?: string | null;
}) {
  const t = useTranslation();
  const chosen = useGroupChoice(groups);
  const [method, setMethod] = useState<Method>("address");
  const [address, setAddress] = useState("");
  const [repo, setRepo] = useState("");
  const [commit, setCommit] = useState("");
  const [folder, setFolder] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAddress("");
    setRepo("");
    setCommit("");
    setFolder("");
    setFile(null);
    setName("");
    setError(null);
    chosen.reset();
  };

  const commitError =
    commit.trim() && !COMMIT.test(commit.trim())
      ? t("Enter the full commit ID: 40 letters and digits.")
      : null;
  const fileError =
    file && file.size > MAX_ARCHIVE_BYTES ? t("This file is larger than 10 MB.") : null;
  const ready =
    groups !== null &&
    (method === "address"
      ? address.trim() !== ""
      : method === "git"
        ? repo.trim() !== "" && COMMIT.test(commit.trim())
        : file !== null && !fileError);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    return (async () => {
      const input: InstallSource =
        method === "address"
          ? { source: { type: "url", url: address.trim() } }
          : method === "git"
            ? {
                source: {
                  type: "git",
                  repo: repo.trim(),
                  ref: commit.trim().toLowerCase(),
                  ...(folder.trim() ? { path: folder.trim().replace(/^\/+|\/+$/g, "") } : {}),
                },
              }
            : await archiveInput(file!);
      const groupIds = [...chosen.value];
      const plugin = await pluginsApi.install({
        ...input,
        ...(name.trim() ? { name: name.trim() } : {}),
        groups: groupIds,
      });
      reset();
      onAdded(plugin, groupIds);
    })()
      .catch((cause: unknown) => {
        setError(pluginErrorText(cause, t("The plugin could not be added.")));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="contents"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !submitting) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("Add your own plugin")}</DialogTitle>
            <DialogDescription>
              {t(
                "For a plugin no registry lists, such as one your company made. The groups you choose get it as soon as it is added.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ToggleGroup
              aria-label={t("Add from")}
              value={[method]}
              onValueChange={(values) => {
                const next = values[0];
                if (next) {
                  setMethod(next as Method);
                  setError(null);
                }
              }}
            >
              <Toggle value="address">{t("Connector address")}</Toggle>
              <Toggle value="git">{t("Git repository")}</Toggle>
              <Toggle value="file">{t("File")}</Toggle>
            </ToggleGroup>

            {method === "address" ? (
              <FormField
                label={t("Connector address")}
                autoFocus
                inputMode="url"
                placeholder="https://mcp.example.com/mcp"
                value={address}
                onChange={(event) => setAddress(event.currentTarget.value)}
                hint={t(
                  "The MCP server address the service gives you. If it needs a key, you add it on the next screen.",
                )}
              />
            ) : method === "git" ? (
              <>
                <FormField
                  label={t("Repository")}
                  autoFocus
                  inputMode="url"
                  placeholder="https://github.com/acme/plugins"
                  value={repo}
                  onChange={(event) => setRepo(event.currentTarget.value)}
                  hint={t("A public GitHub repository. For other places, upload a file instead.")}
                />
                <FormField
                  label={t("Commit")}
                  placeholder="3f9c2e1…"
                  value={commit}
                  onChange={(event) => setCommit(event.currentTarget.value)}
                  error={commitError}
                  hint={t(
                    "The full 40-character commit ID. The plugin stays exactly as it was at that commit.",
                  )}
                />
                <FormField
                  label={t("Folder (optional)")}
                  placeholder="plugins/sales"
                  value={folder}
                  onChange={(event) => setFolder(event.currentTarget.value)}
                />
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="baskule-plugin-file">{t("Plugin file")}</Label>
                <input
                  id="baskule-plugin-file"
                  type="file"
                  accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
                  className="text-sm file:me-3 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-sm file:text-foreground"
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                />
                <p
                  className={
                    fileError
                      ? "text-xs text-destructive-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {fileError ?? t("A .zip or .tar.gz of a skill or a plugin folder, up to 10 MB.")}
                </p>
              </div>
            )}

            <FormField
              label={t("Name (optional)")}
              placeholder={t("Shown to people instead of its own name")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />

            <PluginGroupsField
              groups={groups}
              error={groupsError}
              value={chosen.value}
              onChange={chosen.onChange}
              disabled={submitting}
            />

            {error ? (
              <Alert variant="error" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!ready || submitting}>
              {submitting ? <Spinner size="sm" /> : null}
              {t("Add plugin")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
