import { skillFieldErrors, skillWarnings } from "@t3tools/contracts/baskule-plugin-formats";
import type { PluginFile, SkillHistory, SkillInput } from "@t3tools/contracts/baskule-plugins";
import { BookOpenTextIcon, ChevronRightIcon, HistoryIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useTranslation } from "../../../i18n";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Spinner } from "../../../components/ui/spinner";
import { Textarea } from "../../../components/ui/textarea";
import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { skillFieldErrorText, skillWarningText } from "../../plugins/presentation";
import { FormField, formatBytes, RowIcon } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";

function pathProblem(files: ReadonlyArray<PluginFile>, at: number): "empty" | "duplicate" | null {
  const path = files[at]!.path;
  if (!path) return "empty";
  return path === "SKILL.md" || files.some((file, index) => index !== at && file.path === path)
    ? "duplicate"
    : null;
}

export function skillInvalid(skill: SkillInput, otherNames: ReadonlyArray<string>): boolean {
  return (
    skillFieldErrors(skill, [...otherNames]).length > 0 ||
    skill.files.some((_, at) => pathProblem(skill.files, at) !== null)
  );
}

// Files are read once per file object, so typing in a field doesn't decode every file again.
const fileWarnings = new WeakMap<PluginFile, ReturnType<typeof skillWarnings>>();
function warningsOf(skill: SkillInput) {
  const files = skill.files.flatMap((file) => {
    let found = fileWarnings.get(file);
    if (!found) {
      found = skillWarnings({ name: "", description: "", instructions: "", files: [file] });
      fileWarnings.set(file, found);
    }
    return found;
  });
  return [...skillWarnings({ ...skill, files: [] }), ...files];
}

const decodedSize = (content: string) =>
  Math.floor((content.length * 3) / 4) -
  (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);

export function SkillEditor({
  skill,
  otherNames,
  open,
  showErrors,
  disabled,
  removable,
  onToggle,
  onChange,
  onAddFiles,
  onRemove,
}: {
  readonly skill: SkillInput;
  readonly otherNames: ReadonlyArray<string>;
  readonly open: boolean;
  readonly showErrors: boolean;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly onToggle: () => void;
  readonly onChange: (change: (skill: SkillInput) => SkillInput) => void;
  readonly onAddFiles: (files: ReadonlyArray<File>) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslation();
  const bodyId = useId();
  const descriptionId = useId();
  const instructionsId = useId();
  const filesId = useId();
  const [touched, setTouched] = useState({ name: false, description: false });
  const [view, setView] = useState<"write" | "preview">("write");
  const errors = skillFieldErrors(skill, [...otherNames]);
  const warnings = warningsOf(skill);
  const title = skill.name || t("New skill");
  const set = (patch: Partial<SkillInput>) => onChange((current) => ({ ...current, ...patch }));
  const setFiles = (change: (files: PluginFile[]) => PluginFile[]) =>
    onChange((current) => ({ ...current, files: change(current.files) }));

  const firstError = (field: "name_" | "description_") => {
    const error = errors.find((entry) => entry.startsWith(field));
    return error ? skillFieldErrorText(error) : null;
  };
  const nameError =
    touched.name || showErrors
      ? skill.name
        ? firstError("name_")
        : t("Give the skill a name.")
      : null;
  const descriptionError = touched.description || showErrors ? firstError("description_") : null;

  return (
    <div role="group" aria-label={title} className="flex flex-col gap-4 px-3 py-2.5 sm:px-4">
      <div className="flex min-h-9 items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onToggle}
        >
          <RowIcon>
            <BookOpenTextIcon />
          </RowIcon>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm text-foreground">{title}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {skill.description || t("Skill")}
            </span>
            {!open && warnings.length > 0 ? (
              <span className="text-xs text-warning-foreground">
                {t("{{count}} thing to check", {
                  count: warnings.length,
                  defaultValue_other: "{{count}} things to check",
                })}
              </span>
            ) : null}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={
              open
                ? "size-4 shrink-0 rotate-90 text-muted-foreground"
                : "size-4 shrink-0 text-muted-foreground"
            }
          />
        </button>
        {removable ? (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
            {t("Remove skill")}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div id={bodyId} className="flex flex-col gap-4 pb-1.5 sm:ps-10">
          <FormField
            label={t("Skill name")}
            autoComplete="off"
            spellCheck={false}
            placeholder="call-prep"
            value={skill.name}
            disabled={disabled}
            error={nameError}
            hint={t(
              "Lowercase letters, numbers and hyphens, up to 64 characters. Each skill in a plugin needs its own name.",
            )}
            onBlur={() => setTouched((current) => ({ ...current, name: true }))}
            onChange={(event) => {
              setTouched((current) => ({ ...current, name: true }));
              set({ name: event.currentTarget.value });
            }}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descriptionId}>{t("Skill description")}</Label>
            <Textarea
              id={descriptionId}
              size="sm"
              value={skill.description}
              disabled={disabled}
              aria-invalid={descriptionError ? true : undefined}
              aria-describedby={`${descriptionId}-help`}
              placeholder={t("What it does and when the assistant should use it")}
              onBlur={() => setTouched((current) => ({ ...current, description: true }))}
              onChange={(event) => {
                setTouched((current) => ({ ...current, description: true }));
                set({ description: event.currentTarget.value });
              }}
            />
            <p
              id={`${descriptionId}-help`}
              className={
                descriptionError
                  ? "text-xs text-destructive-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              {descriptionError ??
                t(
                  "The assistant reads this to decide when to use the skill. Up to 1,024 characters.",
                )}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-end justify-between gap-3">
              <Label htmlFor={view === "write" ? instructionsId : undefined}>
                {t("Instructions")}
              </Label>
              <ToggleGroup
                aria-label={t("Show the instructions as")}
                value={[view]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === "write" || next === "preview") setView(next);
                }}
              >
                <Toggle value="write">{t("Write")}</Toggle>
                <Toggle value="preview">{t("Preview")}</Toggle>
              </ToggleGroup>
            </div>
            {view === "write" ? (
              <Textarea
                id={instructionsId}
                spellCheck={false}
                value={skill.instructions}
                disabled={disabled}
                aria-describedby={`${instructionsId}-help`}
                placeholder={t("# Steps\n\n1. Find …\n2. Write …")}
                onChange={(event) => set({ instructions: event.currentTarget.value })}
              />
            ) : (
              <section
                aria-label={t("Preview of the instructions")}
                className="rounded-lg border border-border/60 px-3 py-2"
              >
                {skill.instructions.trim() ? (
                  // Without a raw-HTML plugin, react-markdown shows HTML in the text as text.
                  <div className="chat-markdown text-sm leading-relaxed [overflow-wrap:anywhere]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.instructions}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("Nothing to preview yet.")}</p>
                )}
              </section>
            )}
            <p id={`${instructionsId}-help`} className="text-xs text-muted-foreground">
              {t("In Markdown. The assistant follows these when it uses the skill.")}
            </p>
          </div>

          <div role="group" aria-labelledby={filesId} className="flex flex-col gap-1.5">
            <Label id={filesId} render={<span />}>
              {t("Files")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Scripts, templates and reference files the instructions use. Rename a file to put it in a folder, like scripts/run.py.",
              )}
            </p>
            {skill.files.length > 0 ? (
              <ul className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                {skill.files.map((file, at) => {
                  const problem = pathProblem(skill.files, at);
                  const size = formatBytes(decodedSize(file.content));
                  return (
                    // oxlint-disable-next-line react/no-array-index-key -- paths change as they are typed and may repeat.
                    <li key={at} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            nativeInput
                            size="sm"
                            spellCheck={false}
                            autoComplete="off"
                            aria-label={t("Path of file {{number}}", { number: at + 1 })}
                            aria-invalid={problem ? true : undefined}
                            aria-describedby={problem ? `${filesId}-${at}` : undefined}
                            value={file.path}
                            disabled={disabled}
                            onChange={(event) => {
                              const path = event.currentTarget.value;
                              setFiles((files) =>
                                files.map((entry, index) =>
                                  index === at ? { ...entry, path } : entry,
                                ),
                              );
                            }}
                          />
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {size}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={t("Remove {{path}}", { path: file.path || t("this file") })}
                          disabled={disabled}
                          onClick={() =>
                            setFiles((files) => files.filter((_, index) => index !== at))
                          }
                        >
                          <XIcon />
                        </Button>
                      </div>
                      {problem ? (
                        <p id={`${filesId}-${at}`} className="text-xs text-destructive-foreground">
                          {problem === "empty"
                            ? t("Enter a path for this file.")
                            : file.path === "SKILL.md"
                              ? t("SKILL.md holds the instructions above. Rename this file.")
                              : t("Another file has this path. Rename one of them.")}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <input
              type="file"
              multiple
              aria-label={t("Add files")}
              disabled={disabled}
              className="text-sm file:me-3 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-sm file:text-foreground"
              onChange={(event) => {
                const input = event.currentTarget;
                const picked = [...(input.files ?? [])];
                // Cleared so the same file can be added again after it is removed.
                input.value = "";
                onAddFiles(picked);
              }}
            />
          </div>

          {warnings.length > 0 ? (
            <Alert variant="warning">
              <AlertTitle>{t("Things to check")}</AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-1.5">
                  {warnings.map((entry) => (
                    <li key={`${entry.warning}:${entry.path}`} className="flex flex-col">
                      <span>{skillWarningText(entry.warning)}</span>
                      <span className="font-mono text-xs [overflow-wrap:anywhere]">
                        {entry.path}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="pt-2">{t("You can still save this skill.")}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type RevertState =
  | { readonly version: number; readonly done: boolean }
  | { readonly error: string }
  | null;

export function SkillVersions({
  versions,
  state,
  disabled,
  onRevert,
}: {
  readonly versions: SkillHistory["versions"];
  readonly state: RevertState;
  readonly disabled: boolean;
  readonly onRevert: (version: number) => void;
}) {
  const t = useTranslation();
  const running = state !== null && "done" in state && !state.done ? state.version : null;
  return (
    <PageSection
      title={t("Earlier versions")}
      description={t(
        "Reverting restores this plugin's skills. Its servers and keys stay as they are.",
      )}
    >
      {versions.map(({ version, savedAt }) => (
        <PageRow
          key={version}
          leading={
            <RowIcon>
              <HistoryIcon />
            </RowIcon>
          }
          trailing={
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("Revert to version {{version}}", { version })}
              disabled={disabled || running !== null}
              onClick={() => onRevert(version)}
            >
              {running === version ? <Spinner size="sm" /> : null}
              {t("Revert")}
            </Button>
          }
        >
          <span className="text-sm text-foreground">{t("Version {{version}}", { version })}</span>
          <span className="text-xs text-muted-foreground">
            {t("Used until {{date}}", { date: new Date(savedAt).toLocaleString() })}
          </span>
        </PageRow>
      ))}
      {state !== null && "error" in state ? (
        <p role="alert" className="px-3 py-2.5 text-xs text-destructive-foreground sm:px-4">
          {state.error}
        </p>
      ) : state?.done ? (
        <p role="status" className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {t(
            "The skills of version {{version}} are back and saved. The ones they replaced are kept as an earlier version.",
            { version: state.version },
          )}{" "}
          {t("Other changes on this page are saved only when you click Save plugin.")}
        </p>
      ) : null}
    </PageSection>
  );
}
