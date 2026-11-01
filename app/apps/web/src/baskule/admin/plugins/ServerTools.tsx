// baskule: a server's tools, each with a switch, as the editor's test and a saved plugin's page list them.
// Switched-off tools stay listed so they can be switched back on.
import type { PluginTool } from "@t3tools/contracts/baskule-plugins";

import { useTranslation } from "../../../i18n";
import { Switch } from "../../../components/ui/switch";

export function ServerTools({
  tools,
  disabledTools,
  disabled = false,
  onAllowed,
}: {
  readonly tools: ReadonlyArray<PluginTool>;
  readonly disabledTools: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onAllowed: (tool: string, allowed: boolean) => void;
}) {
  const t = useTranslation();
  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("No tools were found.")}</p>;
  }
  return (
    <div className="flex flex-col rounded-lg border border-border/60">
      <div
        aria-hidden
        className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span>{t("Tools")}</span>
        <span>{t("Allowed")}</span>
      </div>
      <ul aria-label={t("Tools")} className="[&>*]:border-t [&>*]:border-border/50">
        {tools.map((tool) => (
          <li key={tool.name} className="flex items-start gap-3 px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-foreground [overflow-wrap:anywhere]">{tool.name}</span>
              {tool.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {tool.description}
                </span>
              ) : null}
            </span>
            <Switch
              aria-label={t("Allow {{tool}}", { tool: tool.name })}
              checked={!disabledTools.includes(tool.name)}
              disabled={disabled}
              onCheckedChange={(checked) => onAllowed(tool.name, checked)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
