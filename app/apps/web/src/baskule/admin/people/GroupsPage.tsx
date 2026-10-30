import { useTranslation } from "../../../i18n";
// baskule: People → Groups: the built-in "Everyone" and the admin's own groups. A group gives
// its people plugins and permissions; a person gets the sum of their groups.
import type { Group } from "@t3tools/contracts/baskule-plugins";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
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
import { Spinner } from "../../../components/ui/spinner";
import { pluginErrorText, pluginsApi } from "../../plugins/api";
import { groupName } from "../../plugins/presentation";
import { FormField, RowIcon, useApiResource } from "../../ui";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const loadGroups = () => pluginsApi.groups();

export function groupSummary(group: Group, t: ReturnType<typeof useTranslation>): string {
  return [
    group.builtin
      ? t("Every person")
      : t("{{count}} person", {
          count: group.members.length,
          defaultValue_other: "{{count}} people",
        }),
    t("{{count}} plugin", { count: group.plugins.length, defaultValue_other: "{{count}} plugins" }),
    ...(group.permissions.canCreateSpaces ? [t("Can create team spaces")] : []),
  ].join(" · ");
}

export function GroupsPage() {
  const t = useTranslation();
  const data = useApiResource(loadGroups);
  const [creating, setCreating] = useState(false);
  const groups = data.data ?? [];
  return (
    <>
      <PageSection
        title={data.data ? t("Groups ({{count}})", { count: groups.length }) : t("Groups")}
        description={t("A person gets everything their groups give, added together.")}
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            {t("New group")}
          </Button>
        }
      >
        <ResourceState
          error={data.error}
          loading={data.loading}
          empty={groups.length === 0}
          emptyText={t("No groups yet.")}
        />
        {groups.map((group) => {
          const params = { section: "people", page: "groups", item: group.id };
          return (
            <PageRow
              key={group.id}
              leading={
                <RowIcon>
                  <UsersRoundIcon />
                </RowIcon>
              }
              trailing={
                <>
                  {group.builtin ? <Badge variant="secondary">{t("Built in")}</Badge> : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("Open {{name}}", { name: groupName(group) })}
                    render={<Link to="/admin/$section/$page/$item" params={params} />}
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              }
            >
              <Link
                to="/admin/$section/$page/$item"
                params={params}
                className="truncate rounded-sm text-sm text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {groupName(group)}
              </Link>
              <span className="truncate text-xs text-muted-foreground">
                {groupSummary(group, t)}
              </span>
            </PageRow>
          );
        })}
      </PageSection>
      <NewGroupDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewGroupDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="contents"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || submitting) return;
            setSubmitting(true);
            setError(null);
            pluginsApi
              .createGroup({
                name: name.trim(),
                members: [],
                permissions: { canCreateSpaces: false },
                plugins: [],
              })
              .then(
                (group) => {
                  setSubmitting(false);
                  setName("");
                  onOpenChange(false);
                  void navigate({
                    to: "/admin/$section/$page/$item",
                    params: { section: "people", page: "groups", item: group.id },
                  });
                },
                (cause: unknown) => {
                  setSubmitting(false);
                  setError(pluginErrorText(cause, t("The group could not be created.")));
                },
              );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("New group")}</DialogTitle>
            <DialogDescription>
              {t("Then add its people, and choose the plugins and permissions it gives them.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FormField
              label={t("Name")}
              autoFocus
              placeholder={t("Sales, Accounting…")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
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
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? <Spinner size="sm" /> : null}
              {t("Create group")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
