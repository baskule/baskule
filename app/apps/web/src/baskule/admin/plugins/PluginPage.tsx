// baskule: an added plugin's page: who can use it, what each of its apps still needs, its skills,
// and Pause, Resume and Remove.
import type { AdminServer, PluginAccess } from "@t3tools/contracts/baskule-plugins";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { useTranslation } from "../../../i18n";
import { notifyPluginError, pluginsApi } from "../../plugins/api";
import { originHref, pluginSite, providerName } from "../../plugins/presentation";
import { confirmAction, notifySuccess, useApiResource } from "../../ui";
import { groupsApi } from "../people/groups";
import { ResourceState } from "../ResourceState";
import {
  AccessSection,
  AppsSection,
  PluginHeader,
  SkillsSection,
  StatusBadge,
  VariableFields,
} from "./parts";
import { oauthClientFor, SignInSetup } from "./SignInSetup";
import { signInGuide } from "./signInGuides";

export function PluginPage({ id }: { readonly id: string }) {
  const t = useTranslation();
  const navigate = useNavigate();
  // The parent remounts this per item (`key`), so one loader per mount keeps its identity.
  const [load] = useState(
    () => () => Promise.all([pluginsApi.installed(), groupsApi.list().catch(() => [])]),
  );
  const data = useApiResource(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [access, setAccess] = useState<PluginAccess | null>(null);

  if (!data.data) {
    return <ResourceState error={data.error} loading={data.loading} empty emptyText="" />;
  }
  const [list, groups] = data.data;
  const plugin = list.plugins.find((entry) => entry.id === id);
  if (!plugin) {
    return (
      <Navigate
        to="/admin/$section/$page"
        params={{ section: "plugins", page: "installed" }}
        replace
      />
    );
  }

  const run = async (key: string, failure: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
      await data.reload();
      return true;
    } catch (cause) {
      notifyPluginError(failure, cause);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const confirmed = await confirmAction(
      t(
        "Remove {{name}}?\nPeople can no longer use it, and their sign-ins to it are deleted. You can add it again later.",
        { name: plugin.displayName },
      ),
      "destructive",
    );
    if (!confirmed) return;
    setBusy("remove");
    try {
      await pluginsApi.remove(plugin.id);
      notifySuccess(t("{{name}} was removed", { name: plugin.displayName }));
      void navigate({
        to: "/admin/$section/$page",
        params: { section: "plugins", page: "installed" },
      });
    } catch (cause) {
      setBusy(null);
      notifyPluginError(t("Could not remove {{name}}", { name: plugin.displayName }), cause);
    }
  };

  return (
    <>
      <PluginHeader
        name={plugin.displayName}
        logo={plugin.logo}
        site={pluginSite({ homepage: plugin.homepage })}
        sourceHref={originHref(plugin.origin)}
        description={plugin.description}
        status={<StatusBadge status={plugin.status} />}
        actions={
          <>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "enabled",
                  plugin.enabled
                    ? t("Could not pause the plugin")
                    : t("Could not resume the plugin"),
                  () => pluginsApi.update(plugin.id, { enabled: !plugin.enabled }),
                )
              }
            >
              {busy === "enabled" ? <Spinner size="sm" /> : null}
              {plugin.enabled ? t("Pause") : t("Resume")}
            </Button>
            <Button
              variant="destructive-outline"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "remove" ? <Spinner size="sm" /> : null}
              {t("Remove")}
            </Button>
          </>
        }
      />
      {plugin.enabled ? null : (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          {t("Paused: no one can use it until you resume it. Its setup and sign-ins are kept.")}
        </p>
      )}
      <AccessSection
        value={access ?? plugin.access}
        groups={groups}
        disabled={busy !== null}
        busy={busy === "access"}
        onChange={(next) => {
          setAccess(next);
          void run("access", t("Could not change who can use it"), () =>
            pluginsApi.update(plugin.id, { access: next }),
          ).then(() => setAccess(null));
        }}
      />
      <AppsSection
        servers={plugin.servers.map((server) => ({
          key: server.id,
          name: server.name,
          url: server.url,
          auth: server.auth,
          setup: server.setup,
          connectedMembers: server.connectedMembers,
          children: hasSetupPanel(server) ? (
            <ServerSetupPanel
              server={server}
              clients={list.oauthClients}
              busy={busy !== null}
              onSaveValues={(values) =>
                run(`values:${server.id}`, t("Could not save the values"), () =>
                  pluginsApi.update(plugin.id, { values: { [server.name]: values } }),
                )
              }
              onClientSaved={() => data.reload()}
            />
          ) : undefined,
        }))}
      />
      <SkillsSection skills={plugin.skills} />
    </>
  );
}

const hasSetupPanel = (server: AdminServer) =>
  server.variables.length > 0 ||
  server.setup.state !== "ready" ||
  (server.auth.kind === "oauth" && server.auth.registration === "client" && !!server.auth.issuer);

function ServerSetupPanel({
  server,
  clients,
  busy,
  onSaveValues,
  onClientSaved,
}: {
  readonly server: AdminServer;
  readonly clients: Parameters<typeof oauthClientFor>[0];
  readonly busy: boolean;
  readonly onSaveValues: (values: Record<string, string>) => Promise<boolean>;
  readonly onClientSaved: () => Promise<void>;
}) {
  const t = useTranslation();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const filled = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim() !== ""),
  );
  const { auth, setup } = server;
  const parts: ReactNode[] = [];
  if (server.variables.length > 0) {
    parts.push(
      <form
        key="values"
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSaveValues(filled).then((ok) => ok && setValues({}));
        }}
      >
        <VariableFields
          variables={server.variables}
          values={values}
          onChange={(name, value) => setValues({ ...values, [name]: value })}
        />
        <div>
          <Button type="submit" size="sm" disabled={busy || Object.keys(filled).length === 0}>
            {t("Save values")}
          </Button>
        </div>
      </form>,
    );
  }
  if (setup.state === "needs_oauth_client") {
    parts.push(
      <SignInSetup
        key="client"
        client={oauthClientFor(clients, setup.issuer, [hostOf(server.url)])}
        onSaved={onClientSaved}
      />,
    );
  } else if (auth.kind === "oauth" && auth.registration === "client" && auth.issuer) {
    parts.push(
      <p key="client" className="text-xs text-muted-foreground">
        {t("People sign in through your {{vendor}} OAuth client.", {
          vendor: signInGuide(auth.issuer).vendor,
        })}{" "}
        <Link
          to="/admin/$section/$page"
          params={{ section: "plugins", page: "sign-in" }}
          className="text-foreground underline underline-offset-4"
        >
          {t("Change it")}
        </Link>
      </p>,
    );
  }
  if (setup.state === "needs_provider") {
    parts.push(
      <p key="provider" className="text-xs text-muted-foreground">
        {t("Connect {{provider}} so people can connect their accounts.", {
          provider: providerName(setup.provider),
        })}{" "}
        <Link
          to="/admin/$section/$page"
          params={{ section: "plugins", page: "sign-in" }}
          className="text-foreground underline underline-offset-4"
        >
          {t("Open Sign-in and sources")}
        </Link>
      </p>,
    );
  }
  return <div className="flex flex-col gap-3">{parts}</div>;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
