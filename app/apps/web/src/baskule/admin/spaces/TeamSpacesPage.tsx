// baskule: Spaces → Team spaces: shared spaces, their members, creating and managing them.
import { PlusIcon, UsersIcon } from "lucide-react";

import { t, useTranslation } from "../../../i18n";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { type AdminSpace, baskuleApi } from "../../api";
import { openCreateSpace, openSpaceManagement } from "../../SpaceManagementDialog";
import { RowIcon, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

function memberSummary(space: AdminSpace): string {
  const names = space.members.map((member) => member.name);
  if (names.length === 0) return t("No members");
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

const loadAdminSpaces = () => baskuleApi.adminSpaces();

export function TeamSpacesPage() {
  const t = useTranslation();
  const spaces = useApiResource(loadAdminSpaces);
  const list = spaces.data ?? [];
  const team = list.filter((space) => space.kind === "team");
  const reload = () => void spaces.reload();

  return (
    <>
      <PageSection
        title={
          spaces.data ? t("Team spaces ({{length}})", { length: team.length }) : t("Team spaces")
        }
        action={
          <Button size="sm" onClick={() => openCreateSpace(reload)}>
            <PlusIcon />
            {t("New team space")}
          </Button>
        }
      >
        <ResourceState
          error={spaces.error}
          loading={spaces.loading}
          empty={team.length === 0}
          emptyText={t("No team spaces yet.")}
        />
        {team.map((space) => (
          <PageRow
            key={space.id}
            leading={
              <RowIcon>
                <UsersIcon />
              </RowIcon>
            }
            trailing={
              <>
                <Badge variant="secondary">
                  {space.memberCount} {space.memberCount === 1 ? t("member") : t("members")}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openSpaceManagement(space.id, reload)}
                >
                  {t("Manage")}
                </Button>
              </>
            }
          >
            <span className="truncate text-sm text-foreground">{space.name}</span>
            <span className="truncate text-xs text-muted-foreground">{memberSummary(space)}</span>
          </PageRow>
        ))}
      </PageSection>
    </>
  );
}
