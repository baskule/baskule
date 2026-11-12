import {
  GROUP_ERROR_CODES,
  type Group,
  type GroupErrorCode,
  type GroupInput,
} from "@t3tools/contracts/baskule";
import { toastManager } from "../../../components/ui/toast";
import { t } from "../../../i18n";
import { BaskuleApiError, request } from "../../api";

const root = "/api/baskule/admin/groups";
const enc = encodeURIComponent;

export const groupsApi = {
  list: async () => (await request<{ groups: Group[] }>("GET", root)).groups,
  create: (input: GroupInput) => request<Group>("POST", root, input),
  update: (id: string, input: Partial<GroupInput>) =>
    request<Group>("PATCH", `${root}/${enc(id)}`, input),
  remove: (id: string) => request<{ ok: true }>("DELETE", `${root}/${enc(id)}`),
};

/** "Everyone" is created by the system: show its name in the reader's language. */
export function groupName(group: { readonly name: string; readonly builtin?: "everyone" }): string {
  return group.builtin === "everyone" ? t("Everyone") : group.name;
}

const GROUP_ERRORS: Record<GroupErrorCode, () => string> = {
  builtin_group: () => t("Everyone always includes every person, and keeps its name."),
  group_exists: () => t("A group with this name already exists."),
  invalid_group: () => t("Some details aren't valid. Check them and try again."),
  user_not_found: () => t("One of these people no longer exists. Reload the page and try again."),
};

const isGroupErrorCode = (code: string | null): code is GroupErrorCode =>
  code !== null && (GROUP_ERROR_CODES as ReadonlyArray<string>).includes(code);

export function groupErrorText(cause: unknown, fallback: string): string {
  const code = cause instanceof BaskuleApiError ? cause.code : null;
  return isGroupErrorCode(code) ? GROUP_ERRORS[code]() : fallback;
}

export function notifyGroupError(title: string, cause: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: groupErrorText(cause, t("Something went wrong.")),
  });
}
