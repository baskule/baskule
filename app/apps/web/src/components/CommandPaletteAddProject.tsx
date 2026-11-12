import { FolderGit2Icon, LinkIcon } from "lucide-react";
import { type ReactNode } from "react";

import { ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { CommandPaletteTitleIcon } from "./CommandPaletteResults";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The input's trailing submit button for the add-project, clone, and new-project flows. */
export function CommandPaletteSubmitButton(props: {
  readonly id: string;
  readonly label: ReactNode;
  readonly shortcutLabel: string;
  readonly ariaLabel: string;
  readonly tooltip: ReactNode;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            id={props.id}
            variant="outline"
            size="xs"
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            aria-label={props.ariaLabel}
            disabled={props.disabled}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={props.onSubmit}
          />
        }
      >
        <span>{props.label}</span>
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>{props.shortcutLabel}</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function NewProjectSummary(props: {
  readonly name: string;
  readonly pathPreview: string;
  readonly projectsRoot: string | null;
  readonly environmentLabel: string | null;
}) {
  return (
    <div className="p-2 pb-0">
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        <CommandPaletteTitleIcon>
          <FolderGit2Icon className={ITEM_ICON_CLASS} />
        </CommandPaletteTitleIcon>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">
            {props.name.length > 0 ? props.name : "New project"}
          </span>
          <span className="truncate text-muted-foreground/85 text-xs">
            {props.name.length > 0
              ? `Creates ${props.pathPreview}`
              : `Goes in ${props.projectsRoot}`}
            {props.environmentLabel === null ? null : ` on ${props.environmentLabel}`}
          </span>
        </span>
      </div>
    </div>
  );
}

export function RemoteRepositorySummary(props: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="shrink-0 p-2 pb-0">
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        <CommandPaletteTitleIcon>
          <LinkIcon className={ITEM_ICON_CLASS} />
        </CommandPaletteTitleIcon>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">{props.title}</span>
          <span className="truncate text-muted-foreground/85 text-xs">{props.description}</span>
        </span>
      </div>
    </div>
  );
}
