import { useMessages, msg } from "gt-react";

// baskule: Spaces → Personal spaces: one per person, private; the admin can only delete them.

import { Button } from "../../../components/ui/button";
import { baskuleApi } from "../../api";
import { Avatar, confirmAction, notifyError, notifySuccess, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadAdminSpaces = () => baskuleApi.adminSpaces();

export function PersonalSpacesPage() {
  const t = useMessages();
  const spaces = useApiResource(loadAdminSpaces);
  const personal = (spaces.data ?? []).filter((space) => space.kind === "personal");
  const reload = () => void spaces.reload();

  return (
    <PageSection
      title={
        spaces.data
          ? t(msg("Personal spaces ({length})"), { length: personal.length })
          : t(msg("Personal spaces"))
      }
    >
      <ResourceState
        error={spaces.error}
        loading={spaces.loading}
        empty={personal.length === 0}
        emptyText={t(msg("No personal spaces."))}
      />
      {personal.map((space) => (
        <PageRow
          key={space.id}
          leading={<Avatar name={space.ownerName ?? space.name} />}
          trailing={
            <Button
              variant="ghost-destructive"
              size="sm"
              onClick={() =>
                void confirmAction(
                  `Delete the personal space of ${space.ownerName ?? "this person"}?\nTheir chats, files and computer are deleted, and they get an empty personal space. This can't be undone.`,
                  "destructive",
                ).then(async (confirmed) => {
                  if (!confirmed) return;
                  try {
                    await baskuleApi.deleteSpace(space.id);
                    notifySuccess(t(msg("Personal space deleted")));
                    reload();
                  } catch (cause) {
                    notifyError(t(msg("Could not delete the space")), cause);
                  }
                })
              }
            >
              {t(msg("Delete"))}
            </Button>
          }
        >
          <span className="truncate text-sm text-foreground">{space.ownerName ?? space.name}</span>
          <span className="truncate text-xs text-muted-foreground">{t(msg("Personal space"))}</span>
        </PageRow>
      ))}
    </PageSection>
  );
}
