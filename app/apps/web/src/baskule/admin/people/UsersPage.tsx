// baskule: People → Users: everyone who can sign in, their role and their access. What a person
// may do beyond their role (create team spaces, use plugins) comes from their groups.
import { Link } from "@tanstack/react-router";
import { EllipsisIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { t, useTranslation } from "../../../i18n";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../../components/ui/menu";
import { Spinner } from "../../../components/ui/spinner";
import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { type Person, baskuleApi } from "../../api";
import { pluginsApi } from "../../plugins/api";
import { groupName } from "../../plugins/presentation";
import { useBaskuleMe } from "../../session";
import {
  Avatar,
  confirmAction,
  generateTemporaryPassword,
  notifyError,
  notifySuccess,
  useApiResource,
} from "../../ui";
import { absoluteInvitationUrl, AddPersonDialog } from "../../views/AddPersonDialog";
import { PageRow, PageSection } from "../../views/BaskulePage";
import { ResourceState } from "../ResourceState";

const STATUS_BADGES: Record<
  Person["status"],
  { label: string; variant: "warning" | "secondary" } | null
> = {
  active: null,
  invited: {
    get label() {
      return t("Not signed in yet");
    },
    variant: "warning",
  },
  deactivated: {
    get label() {
      return t("Deactivated");
    },
    variant: "secondary",
  },
};

const loadPeople = () => baskuleApi.people();
const loadGroups = () => pluginsApi.groups();

export function UsersPage() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const data = useApiResource(loadPeople);
  const groups = useApiResource(loadGroups);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (
    id: string,
    action: () => Promise<unknown>,
    failure: string,
    success?: string,
  ) => {
    setBusyId(id);
    try {
      await action();
      if (success) notifySuccess(success);
      await data.reload();
    } catch (cause) {
      notifyError(failure, cause);
    } finally {
      setBusyId(null);
    }
  };
  const confirmThen = (message: string, variant: "default" | "destructive", run: () => void) =>
    void confirmAction(message, variant).then((confirmed) => {
      if (confirmed) run();
    });

  const list = data.data ?? [];
  const admins = list.filter(
    (person) => person.role === "admin" && person.status !== "deactivated",
  );

  return (
    <>
      <PageSection
        title={data.data ? t("People ({{length}})", { length: list.length }) : t("People")}
        description={
          <>
            {t("Plugins and permissions such as creating team spaces come from groups.")}{" "}
            <Link
              to="/admin/$section/$page"
              params={{ section: "people", page: "groups" }}
              className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {t("Manage groups")}
            </Link>
          </>
        }
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
          empty={list.length === 0}
          emptyText={t("No people yet.")}
        />
        {list.map((person) => {
          const isMe = person.id === me?.user.id;
          const lastAdmin = person.role === "admin" && admins.length === 1;
          const badge = STATUS_BADGES[person.status];
          const deactivated = person.status === "deactivated";
          const extraGroups = (groups.data ?? [])
            .filter((group) => !group.builtin && group.members.includes(person.id))
            .map(groupName);
          return (
            <PageRow
              key={person.id}
              muted={deactivated}
              leading={<Avatar name={person.name} />}
              trailing={
                <>
                  {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
                  {person.role === "admin" ? <Badge variant="info">{t("Admin")}</Badge> : null}
                  {busyId === person.id ? <Spinner size="sm" tone="muted" /> : null}
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("Options for {{name}}", { name: person.name })}
                          disabled={busyId === person.id}
                        />
                      }
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        disabled={isMe || lastAdmin}
                        onClick={() =>
                          void act(
                            person.id,
                            () =>
                              baskuleApi.updatePerson(person.id, {
                                role: person.role === "admin" ? "member" : "admin",
                              }),
                            "Could not change the role",
                          )
                        }
                      >
                        {person.role === "admin" ? t("Make member") : t("Make admin")}
                      </MenuItem>
                      <MenuSeparator />
                      {!me?.authentication.password ? null : person.status === "invited" ? (
                        <MenuItem
                          onClick={() => {
                            const password = generateTemporaryPassword();
                            void act(
                              person.id,
                              async () => {
                                await baskuleApi.setTemporaryPassword(person.id, password);
                                await writeTextToClipboard(password);
                              },
                              "Could not set a password",
                              "New temporary password copied",
                            );
                          }}
                        >
                          {t("Copy a new temporary password")}
                        </MenuItem>
                      ) : (
                        <MenuItem
                          disabled={deactivated}
                          onClick={() =>
                            confirmThen(
                              `Create a password reset link for ${person.name}?\nThe link works once, for one hour. Using it signs them out everywhere.`,
                              "default",
                              () =>
                                void act(
                                  person.id,
                                  async () => {
                                    const { url } = await baskuleApi.resetLink(person.id);
                                    await writeTextToClipboard(absoluteInvitationUrl(url));
                                  },
                                  "Could not create a reset link",
                                  "Reset link copied",
                                ),
                            )
                          }
                        >
                          {t("Copy a password reset link")}
                        </MenuItem>
                      )}
                      <MenuItem
                        disabled={deactivated || person.activeSessions === 0}
                        onClick={() =>
                          confirmThen(
                            `Sign ${person.name} out everywhere?\nEvery device they use is signed out at once. They can sign in again.`,
                            "default",
                            () =>
                              void act(
                                person.id,
                                () => baskuleApi.signOutPerson(person.id),
                                "Could not sign them out",
                                `${person.name} was signed out everywhere`,
                              ),
                          )
                        }
                      >
                        {t("Sign out everywhere")}
                      </MenuItem>
                      <MenuItem
                        disabled={isMe || (lastAdmin && !deactivated)}
                        onClick={() =>
                          deactivated
                            ? void act(
                                person.id,
                                () => baskuleApi.setDeactivated(person.id, false),
                                "Could not reactivate",
                                `${person.name} can sign in again`,
                              )
                            : confirmThen(
                                `Deactivate ${person.name}?\nThey are signed out everywhere and can't sign in until you reactivate them. Their spaces are kept.`,
                                "destructive",
                                () =>
                                  void act(
                                    person.id,
                                    () => baskuleApi.setDeactivated(person.id, true),
                                    "Could not deactivate",
                                  ),
                              )
                        }
                      >
                        {deactivated ? t("Reactivate") : t("Deactivate")}
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        disabled={isMe || lastAdmin}
                        onClick={() =>
                          confirmThen(
                            `Delete ${person.name}?\nTheir account and personal space (chats, files, computer) are deleted. Team spaces are kept. This can't be undone.`,
                            "destructive",
                            () =>
                              void act(
                                person.id,
                                () => baskuleApi.deletePerson(person.id),
                                "Could not delete the person",
                                `${person.name} was deleted`,
                              ),
                          )
                        }
                      >
                        {t("Delete…")}
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              }
            >
              <span className="truncate text-sm text-foreground">
                {person.name}
                {isMe ? <span className="text-muted-foreground"> {t("(you)")}</span> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {person.email}
                {extraGroups.length > 0 ? <> · {extraGroups.join(", ")}</> : null}
                {person.status === "active" ? (
                  <span className="max-sm:hidden">
                    {" · "}
                    {person.activeSessions === 0
                      ? t("Signed out")
                      : t("Signed in on {{activeSessions}} device", {
                          activeSessions: person.activeSessions,
                          count: person.activeSessions,
                          defaultValue_other: "Signed in on {{activeSessions}} devices",
                        })}
                  </span>
                ) : null}
              </span>
            </PageRow>
          );
        })}
      </PageSection>
      <AddPersonDialog open={adding} onOpenChange={setAdding} onAdded={() => void data.reload()} />
    </>
  );
}
