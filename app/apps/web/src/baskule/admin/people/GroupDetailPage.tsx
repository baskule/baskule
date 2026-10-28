// baskule: one group: its name, its people, the permissions and the plugins it gives them.
// "Everyone" has every person automatically and keeps its name; its permissions and plugins change.
import type { GroupInput } from "@t3tools/contracts/baskule-plugins";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { UserPlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Spinner } from "../../../components/ui/spinner";
import { Switch } from "../../../components/ui/switch";
import { baskuleApi } from "../../api";
import { refreshBaskuleMe } from "../../session";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import { PluginIcon, PluginTitle } from "../../plugins/PluginParts";
import { groupName } from "../../plugins/presentation";
import { Avatar, confirmAction, FormField, notifySuccess, useApiResource } from "../../ui";
import { PageMessage, PageRow, PageSection } from "../../views/BaskulePage";
import { AdminPageHeading } from "../AdminShell";
import { ResourceState } from "../ResourceState";
import { groupSummary } from "./GroupsPage";

export function GroupDetailPage({ id }: { readonly id: string }) {
  const t = useTranslation();
  const navigate = useNavigate();
  // The parent remounts this per item (`key`), so one loader per mount keeps its identity.
  const [load] = useState(
    () => () =>
      Promise.all([pluginsApi.groups(), baskuleApi.people(), pluginsApi.installed()]).then(
        ([groups, people, plugins]) => ({
          group: groups.find((entry) => entry.id === id) ?? null,
          people,
          plugins,
        }),
      ),
  );
  const data = useApiResource(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  if (!data.data) {
    return <ResourceState error={data.error} loading={data.loading} empty emptyText="" />;
  }
  const { group, people, plugins } = data.data;
  if (!group) {
    return (
      <Navigate to="/admin/$section/$page" params={{ section: "people", page: "groups" }} replace />
    );
  }
  const builtin = group.builtin === "everyone";
  const shownName = groupName(group);

  const save = async (key: string, patch: Partial<GroupInput>, failure: string) => {
    setBusy(key);
    return (async () => {
      await pluginsApi.updateGroup(group.id, patch);
      await data.reload();
      // The signed-in admin may have just gained or lost a permission.
      if (patch.permissions) void refreshBaskuleMe().catch(() => undefined);
      return true;
    })()
      .catch((cause: unknown) => {
        notifyPluginError(failure, cause);
        return false;
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const members = people.filter((person) => group.members.includes(person.id));
  const candidates = people.filter(
    (person) => !group.members.includes(person.id) && person.status !== "deactivated",
  );
  const draftName = name ?? group.name;

  return (
    <>
      <AdminPageHeading
        title={shownName}
        description={groupSummary(group, t)}
        trailing={
          builtin ? null : (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy !== null}
              onClick={() =>
                void confirmAction(
                  t(
                    "Delete {{name}}?\nIts people keep their accounts and spaces, but lose the plugins and permissions it gave them.",
                    { name: shownName },
                  ),
                  "destructive",
                ).then(async (confirmed) => {
                  if (!confirmed) return;
                  setBusy("delete");
                  try {
                    await pluginsApi.removeGroup(group.id);
                    notifySuccess(t("{{name}} was deleted", { name: shownName }));
                    void navigate({
                      to: "/admin/$section/$page",
                      params: { section: "people", page: "groups" },
                    });
                  } catch (cause) {
                    setBusy(null);
                    notifyPluginError(t("Could not delete {{name}}", { name: shownName }), cause);
                  }
                })
              }
            >
              {t("Delete group…")}
            </Button>
          )
        }
      />

      {builtin ? null : (
        <form
          className="flex items-end gap-2 px-3 sm:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            const next = draftName.trim();
            if (!next || next === group.name) return;
            void save("name", { name: next }, t("Could not rename the group")).then(
              (ok) => ok && setName(null),
            );
          }}
        >
          <FormField
            className="flex-1"
            label={t("Name")}
            value={draftName}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy !== null || !draftName.trim() || draftName.trim() === group.name}
          >
            {t("Rename")}
          </Button>
        </form>
      )}

      <PageSection
        title={builtin ? t("People") : t("People ({{count}})", { count: members.length })}
      >
        {builtin ? (
          <PageMessage>
            {t(
              "Everyone always includes every person, also the ones you add later. To give some people more, put them in another group.",
            )}
          </PageMessage>
        ) : (
          <>
            {members.length === 0 ? (
              <PageMessage>{t("No one is in this group yet.")}</PageMessage>
            ) : null}
            {members.map((person) => (
              <PageRow
                key={person.id}
                muted={person.status === "deactivated"}
                leading={<Avatar name={person.name} />}
                trailing={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("Remove {{name}} from the group", { name: person.name })}
                    disabled={busy !== null}
                    onClick={() =>
                      void save(
                        `member:${person.id}`,
                        { members: group.members.filter((entry) => entry !== person.id) },
                        t("Could not remove {{name}}", { name: person.name }),
                      )
                    }
                  >
                    {busy === `member:${person.id}` ? <Spinner size="sm" /> : <XIcon />}
                  </Button>
                }
              >
                <span className="truncate text-sm text-foreground">{person.name}</span>
                <span className="truncate text-xs text-muted-foreground">{person.email}</span>
              </PageRow>
            ))}
            <form
              className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:px-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!adding) return;
                void save(
                  "add",
                  { members: [...group.members, adding] },
                  t("Could not add the person"),
                ).then((ok) => ok && setAdding(null));
              }}
            >
              <Select value={adding} onValueChange={(value) => setAdding(value as string | null)}>
                <SelectTrigger className="sm:flex-1" aria-label={t("Person to add")}>
                  <SelectValue>
                    {(value: string | null) =>
                      candidates.find((person) => person.id === value)?.name ?? (
                        <span className="text-muted-foreground">{t("Choose a person")}</span>
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {candidates.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      {t("Everyone is already in this group.")}
                    </div>
                  ) : (
                    candidates.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{person.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {person.email}
                          </span>
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectPopup>
              </Select>
              <Button type="submit" disabled={busy !== null || !adding}>
                {busy === "add" ? <Spinner size="sm" /> : <UserPlusIcon />}
                {t("Add")}
              </Button>
            </form>
          </>
        )}
      </PageSection>

      <PageSection title={t("Permissions")}>
        <PageRow
          trailing={
            <>
              {busy === "permissions" ? <Spinner size="sm" tone="muted" /> : null}
              <Switch
                aria-label={t("Can create team spaces")}
                checked={group.permissions.canCreateSpaces}
                disabled={busy !== null}
                onCheckedChange={(canCreateSpaces) =>
                  void save(
                    "permissions",
                    { permissions: { ...group.permissions, canCreateSpaces } },
                    t("Could not change the permission"),
                  )
                }
              />
            </>
          }
        >
          <span className="text-sm text-foreground">{t("Can create team spaces")}</span>
          <span className="text-xs text-muted-foreground">
            {t("They become the owner of the spaces they create. Admins always can.")}
          </span>
        </PageRow>
      </PageSection>

      <PageSection
        title={t("Plugins")}
        description={t("Its people can turn these on for themselves in Settings → Plugins.")}
      >
        {plugins.length === 0 ? (
          <PageMessage>
            <span className="flex flex-col items-center gap-3">
              {t("No plugins are installed yet.")}
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/admin/$section/$page"
                    params={{ section: "plugins", page: "catalog" }}
                  />
                }
              >
                {t("Find plugins")}
              </Button>
            </span>
          </PageMessage>
        ) : null}
        {plugins.map((plugin) => {
          const allowed = group.plugins.includes(plugin.id);
          return (
            <PageRow
              key={plugin.id}
              leading={<PluginIcon kind={plugin.kind} icon={plugin.icon} />}
              trailing={
                <>
                  {busy === `plugin:${plugin.id}` ? <Spinner size="sm" tone="muted" /> : null}
                  <Switch
                    aria-label={t("{{group}} can use {{name}}", {
                      group: shownName,
                      name: plugin.name,
                    })}
                    checked={allowed}
                    disabled={busy !== null}
                    onCheckedChange={(checked) =>
                      void save(
                        `plugin:${plugin.id}`,
                        {
                          plugins: checked
                            ? [...group.plugins, plugin.id]
                            : group.plugins.filter((entry) => entry !== plugin.id),
                        },
                        t("Could not change the plugins of {{name}}", { name: shownName }),
                      )
                    }
                  />
                </>
              }
            >
              <PluginTitle
                name={plugin.name}
                kind={plugin.kind}
                extra={plugin.enabled ? null : t("Off for everyone")}
              />
            </PageRow>
          );
        })}
      </PageSection>
    </>
  );
}
