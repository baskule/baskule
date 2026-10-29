import { Button } from "../../components/ui/button";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { useTranslation } from "../../i18n";
import { openCreateSpace, openSpaceManagement } from "../SpaceManagementDialog";
import { useBaskuleMe } from "../session";
import { PageRow, PageSection } from "./BaskulePage";

export function SpacesSettingsView() {
  const t = useTranslation();
  const me = useBaskuleMe();
  return (
    <SettingsPageContainer>
      <PageSection
        title={t("Your spaces")}
        action={
          me?.canCreateSpaces ? (
            <Button size="sm" onClick={() => openCreateSpace()}>
              {t("New team space")}
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
                  {t("Manage")}
                </Button>
              ) : null
            }
          >
            <span className="truncate text-sm">{space.name}</span>
            <span className="text-xs text-muted-foreground">
              {space.kind === "personal"
                ? t("Personal space")
                : space.role === "owner"
                  ? t("Owner")
                  : t("Member")}
            </span>
          </PageRow>
        ))}
      </PageSection>
    </SettingsPageContainer>
  );
}
