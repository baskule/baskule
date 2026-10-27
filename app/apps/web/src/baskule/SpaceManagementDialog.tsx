import { t, useTranslation } from "../i18n";
// baskule: manage one team space (name, members, roles, plugins, deletion). Opened from the admin
// spaces list and, for space owners, from the user menu. "New team space" uses the same dialog.
import { EllipsisIcon, UserPlusIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { BaskuleApiError, type SpaceDetails, type SpaceRole, baskuleApi } from "./api";
import { SpacePluginSettings } from "./plugins/SpacePluginSettings";
import { refreshBaskuleMe, useBaskuleMe } from "./session";
import { Avatar, confirmAction, errorText, FormField, notifyError, notifySuccess } from "./ui";

type DialogTarget =
  | { readonly kind: "closed" }
  | { readonly kind: "create"; readonly onDone?: () => void }
  | { readonly kind: "manage"; readonly spaceId: string; readonly onDone?: () => void };

let target: DialogTarget = { kind: "closed" };
const listeners = new Set<() => void>();
const publish = (next: DialogTarget) => {
  target = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => target;

export function openSpaceManagement(spaceId: string, onDone?: () => void) {
  publish({ kind: "manage", spaceId, ...(onDone ? { onDone } : {}) });
}

export function openCreateSpace(onDone?: () => void) {
  publish({ kind: "create", ...(onDone ? { onDone } : {}) });
}

export function SpaceManagementDialogHost() {
  const current = useSyncExternalStore(subscribe, read, read);
  const [visible, setVisible] = useState(current);
  if (current.kind !== "closed" && current !== visible) setVisible(current);
  const close = () => {
    if (visible.kind !== "closed") visible.onDone?.();
    // Spaces may have been added, renamed or left: refresh the sidebar's environments.
    void refreshBaskuleMe().catch(() => undefined);
    publish({ kind: "closed" });
  };
  return (
    <Dialog open={current.kind !== "closed"} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="sm:max-w-lg">
        {visible.kind === "create" ? (
          <CreateSpaceContent
            onCreated={(space) => publish({ kind: "manage", spaceId: space.id })}
            onCancel={close}
          />
        ) : visible.kind === "manage" ? (
          <ManageSpaceContent key={visible.spaceId} spaceId={visible.spaceId} onClose={close} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CreateSpaceContent({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (space: SpaceDetails) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslation();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || submitting) return;
        setSubmitting(true);
        setError(null);
        baskuleApi.createSpace({ name: name.trim() }).then(
          (space) => {
            notifySuccess(
              t("{{name}} created", { name: space.name }),
              t("Add the people who work in it."),
            );
            onCreated(space);
          },
          (cause: unknown) => {
            setError(errorText(cause, "The space could not be created."));
            setSubmitting(false);
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("New team space")}</DialogTitle>
        <DialogDescription>
          {t("Members of a team space share its chats, files and computer. You will be its owner.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <FormField
          label={t("Name")}
          autoFocus
          placeholder={t("Marketing, Acme project…")}
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
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={!name.trim() || submitting}>
          {submitting ? <Spinner size="sm" /> : null}
          {t("Create space")}
        </Button>
      </DialogFooter>
    </form>
  );
}

const ROLE_LABELS: Record<SpaceRole, string> = {
  get owner() {
    return t("Owner");
  },
  get member() {
    return t("Member");
  },
};

function ManageSpaceContent({
  spaceId,
  onClose,
}: {
  readonly spaceId: string;
  readonly onClose: () => void;
}) {
  const t = useTranslation();
  const me = useBaskuleMe();
  const [space, setSpace] = useState<SpaceDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly email: string;
  }> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ userId: string | null; role: SpaceRole }>({
    userId: null,
    role: "member",
  });

  useEffect(() => {
    let cancelled = false;
    baskuleApi.space(spaceId).then(
      (found) => {
        if (cancelled) return;
        setSpace(found);
        setName(found.name);
      },
      (cause: unknown) =>
        !cancelled &&
        setLoadError(
          cause instanceof BaskuleApiError && cause.status === 404
            ? "This space no longer exists, or you can't manage it."
            : errorText(cause),
        ),
    );
    baskuleApi.directory().then(
      (people) => !cancelled && setDirectory(people),
      () => !cancelled && setDirectory([]),
    );
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const run = async (action: () => Promise<SpaceDetails | unknown>, failure: string) => {
    setBusy(true);
    try {
      const result = await action();
      if (result && typeof result === "object" && "members" in result) {
        setSpace(result as SpaceDetails);
      }
      return true;
    } catch (cause) {
      notifyError(failure, cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("Space unavailable")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Alert variant="error">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </>
    );
  }
  if (space === null) {
    return (
      <DialogPanel>
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          {t("Loading the space…")}
        </p>
      </DialogPanel>
    );
  }

  const owners = space.members.filter((member) => member.role === "owner");
  const memberIds = new Set(space.members.map((member) => member.userId));
  const candidates = (directory ?? []).filter((person) => !memberIds.has(person.id));
  const isPersonal = space.kind === "personal";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{space.name}</DialogTitle>
        <DialogDescription>
          {isPersonal
            ? t("A personal space is private to its person.")
            : t("Everyone listed here sees every chat, file and the computer of this space.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {isPersonal ? null : (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || name.trim() === space.name) return;
              void run(
                () => baskuleApi.renameSpace(space.id, { name: name.trim() }),
                "Could not rename the space",
              );
            }}
          >
            <FormField
              className="flex-1"
              label={t("Name")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !name.trim() || name.trim() === space.name}
            >
              {t("Rename")}
            </Button>
          </form>
        )}

        <div className="flex flex-col gap-1.5">
          <Label>
            {t("Members (")}
            {space.members.length})
          </Label>
          <ul className="flex flex-col rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
            {space.members.map((member) => {
              const lastOwner = member.role === "owner" && owners.length === 1;
              const isMe = member.userId === me?.user.id;
              return (
                <li key={member.userId} className="flex items-center gap-2.5 px-3 py-2">
                  <Avatar name={member.name} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">
                      {member.name}
                      {isMe ? <span className="text-muted-foreground"> {t("(you)")}</span> : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                  </div>
                  <Badge variant={member.role === "owner" ? "info" : "secondary"}>
                    {ROLE_LABELS[member.role]}
                  </Badge>
                  {isPersonal ? null : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("Options for {{name}}", { name: member.name })}
                            disabled={busy}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem
                          disabled={lastOwner}
                          onClick={() =>
                            void run(
                              () =>
                                baskuleApi.setMemberRole(space.id, member.userId, {
                                  role: member.role === "owner" ? "member" : "owner",
                                }),
                              "Could not change the role",
                            )
                          }
                        >
                          {member.role === "owner" ? t("Make member") : t("Make owner")}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          variant="destructive"
                          disabled={lastOwner}
                          onClick={() => {
                            void confirmAction(
                              `Remove ${member.name} from ${space.name}?\nThey lose access at once, including on devices where it is open.`,
                              "destructive",
                            ).then((confirmed) => {
                              if (!confirmed) return;
                              void run(
                                async () => {
                                  await baskuleApi.removeMember(space.id, member.userId);
                                  return isMe ? null : baskuleApi.space(space.id);
                                },
                                isMe ? "Could not leave the space" : "Could not remove the member",
                              ).then((ok) => {
                                if (ok && isMe) onClose();
                              });
                            });
                          }}
                        >
                          {isMe ? t("Leave space") : t("Remove from space")}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  )}
                </li>
              );
            })}
          </ul>
          {owners.length === 1 && !isPersonal ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "A space keeps at least one owner. Make someone else owner before changing yours.",
              )}
            </p>
          ) : null}
        </div>

        {isPersonal ? null : (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const userId = adding.userId;
              if (!userId) return;
              void run(
                () => baskuleApi.addMember(space.id, { userId, role: adding.role }),
                "Could not add the member",
              ).then((ok) => ok && setAdding({ userId: null, role: "member" }));
            }}
          >
            <Label>{t("Add a member")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={adding.userId}
                onValueChange={(value) =>
                  setAdding((current) => ({ ...current, userId: value as string | null }))
                }
              >
                <SelectTrigger className="sm:flex-1" aria-label={t("Person to add")}>
                  <SelectValue>
                    {(value: string | null) =>
                      candidates.find((person) => person.id === value)?.name ?? (
                        <span className="text-muted-foreground">
                          {directory === null ? t("Loading people…") : t("Choose a person")}
                        </span>
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {candidates.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      {t("Everyone is already a member.")}
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
              <div className="flex gap-2">
                <Select
                  value={adding.role}
                  onValueChange={(value) =>
                    setAdding((current) => ({ ...current, role: value as SpaceRole }))
                  }
                >
                  <SelectTrigger className="min-w-28" aria-label={t("Role in the space")}>
                    <SelectValue>{(value: SpaceRole) => ROLE_LABELS[value]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="member">{t("Member")}</SelectItem>
                    <SelectItem value="owner">{t("Owner")}</SelectItem>
                  </SelectPopup>
                </Select>
                <Button type="submit" disabled={busy || !adding.userId}>
                  <UserPlusIcon />
                  {t("Add")}
                </Button>
              </div>
            </div>
          </form>
        )}
        {isPersonal ? null : (
          <SpacePluginSettings spaceId={space.id} isAdmin={me?.user.role === "admin"} />
        )}
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="destructive-outline"
          className="sm:me-auto"
          disabled={busy}
          onClick={() => {
            void confirmAction(
              `Delete ${space.name}?\nEvery chat, file and the computer of this space are deleted for all its members. This can't be undone.`,
              "destructive",
            ).then((confirmed) => {
              if (!confirmed) return;
              void run(() => baskuleApi.deleteSpace(space.id), "Could not delete the space").then(
                (ok) => {
                  if (!ok) return;
                  notifySuccess(t("{{name}} deleted", { name: space.name }));
                  onClose();
                },
              );
            });
          }}
        >
          {t("Delete space")}
        </Button>
        <Button onClick={onClose}>{t("Done")}</Button>
      </DialogFooter>
    </>
  );
}
