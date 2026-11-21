import { useMessages, msg } from "gt-react";

import { Button } from "../../components/ui/button";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";

import { openCreateSpace, openSpaceManagement } from "../SpaceManagementDialog";
import { useBaskuleMe } from "../session";
import { PageRow, PageSection } from "./BaskulePage";

export function SpacesSettingsView() {
  const t = useMessages();
  const me = useBaskuleMe();
  return (
    <SettingsPageContainer>
      <PageSection
        title={t(msg("Your spaces"))}
        action={
          me?.canCreateSpaces ? (
            <Button size="sm" onClick={() => openCreateSpace()}>
              {t(msg("New team space"))}
            </Button>
          ) : null
        }
      >
        {me?.spaces.map((space) => (
          <PageRow
            key={space.id}
            trailing={
              space.role === "owner" || me.user.role === "admin" ? (
                <Button variant="outline" size="sm" onClick={() => openSpaceManagement(space.id)}>
                  {t(msg("Manage"))}
                </Button>
              ) : null
            }
          >
            <span className="truncate text-sm">{space.name}</span>
            <span className="text-xs text-muted-foreground">
              {space.kind === "personal"
                ? t(msg("Personal space"))
                : space.role === "owner"
                  ? t(msg("Owner"))
                  : t(msg("Member"))}
            </span>
          </PageRow>
        ))}
      </PageSection>
    </SettingsPageContainer>
  );
}
