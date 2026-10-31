import { useTranslation } from "../i18n";

// baskule: ChatGPT-like sidebar header: a full-width "New chat" row above the search field. A copy
// of upstream's search field (SidebarThreadHeader) so the upstream file only gains a wrapper.
import { SearchIcon, SquarePenIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SidebarInput, SidebarMenuButton } from "~/components/ui/sidebar";
import type { SidebarThreadHeaderProps } from "~/components/sidebar/SidebarThreadHeader";

export function BaskuleSidebarHeader({
  searchFieldRef,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const t = useTranslation();
  const resultsVisible = isSearching && searchResultCount > 0;
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  return (
    <div className="flex flex-col gap-px">
      <SidebarMenuButton
        type="button"
        data-testid="baskule-new-chat"
        disabled={newThreadDisabled}
        onClick={onNewThread}
      >
        <SquarePenIcon className="size-4" />
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{t("New chat")}</span>
        {newThreadShortcutLabel ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {newThreadShortcutLabel}
          </span>
        ) : null}
      </SidebarMenuButton>
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <SidebarInput
          ref={searchInputRef}
          nativeInput
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("Search chats")}
          aria-label={t("Search chats")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          className="min-w-0 flex-1"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label={t("Clear chat search")}
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
