import { useState } from "react";
import { Button } from "../../components/ui/button";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { useTranslation } from "../../i18n";
import { ChangePasswordDialog } from "../ChangePasswordDialog";
import { useBaskuleMe } from "../session";
import { PageRow, PageSection } from "./BaskulePage";

export function AccountSettingsView() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const [changingPassword, setChangingPassword] = useState(false);
  return (
    <SettingsPageContainer>
      <PageSection title={t("Account")}>
        <PageRow>
          <span>{me?.user.name}</span>
          <span className="text-sm text-muted-foreground">{me?.user.email}</span>
        </PageRow>
        {me?.authentication.password ? (
          <PageRow
            trailing={
              <Button variant="outline" onClick={() => setChangingPassword(true)}>
                {t("Change password")}
              </Button>
            }
          >
            <span className="text-sm">{t("Password")}</span>
          </PageRow>
        ) : (
          <PageRow>
            <span className="text-sm text-muted-foreground">
              {t("Password sign-in is unavailable on this server.")}
            </span>
          </PageRow>
        )}
      </PageSection>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </SettingsPageContainer>
  );
}
