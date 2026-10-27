// baskule: People → Invitations: links not used yet, and revoking them.
import { MailIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { baskuleApi } from "../../api";
import { notifyError, notifySuccess, RowIcon, useApiResource } from "../../ui";
import { AddPersonDialog } from "../../views/AddPersonDialog";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadInvitations = () => baskuleApi.invitations();

export function InvitationsPage() {
  const t = useTranslation();
  const data = useApiResource(loadInvitations);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const invitations = data.data ?? [];

  const revoke = async (id: string) => {
    setBusyId(id);
    try {
      await baskuleApi.revokeInvitation(id);
      notifySuccess(t("Invitation revoked"));
      await data.reload();
    } catch (cause) {
      notifyError(t("Could not revoke the invitation"), cause);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageSection
        title={
          data.data
            ? t("Pending invitations ({{length}})", { length: invitations.length })
            : t("Pending invitations")
        }
        description={t("A lost link can't be shown again: revoke it and invite again.")}
        action={
          <Button size="sm" onClick={() => setAdding(true)}>
            <UserPlusIcon />
            {t("Add person")}
          </Button>
        }
      >
        <ResourceState
          error={data.error}
          loading={data.loading}
          empty={invitations.length === 0}
          emptyText={t("No pending invitations.")}
        />
        {invitations.map((invitation) => (
          <PageRow
            key={invitation.id}
            leading={
              <RowIcon>
                <MailIcon />
              </RowIcon>
            }
            trailing={
              <>
                {invitation.role === "admin" ? <Badge variant="info">{t("Admin")}</Badge> : null}
                <Button
                  variant="ghost-destructive"
                  size="sm"
                  disabled={busyId === invitation.id}
                  onClick={() => void revoke(invitation.id)}
                >
                  {t("Revoke")}
                </Button>
              </>
            }
          >
            <span className="truncate text-sm text-foreground">{invitation.email}</span>
            <span className="truncate text-xs text-muted-foreground">
              {t("Expires")} {new Date(invitation.expiresAt).toLocaleString()}
            </span>
          </PageRow>
        ))}
      </PageSection>
      <AddPersonDialog open={adding} onOpenChange={setAdding} onAdded={() => void data.reload()} />
    </>
  );
}
