import { t, useTranslation } from "../../i18n";
// baskule: desktop (and mobile) apps published with the installation (E10).
import { DownloadIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { type Download, baskuleApi } from "../api";
import { formatBytes, useApiResource } from "../ui";
import { ConnectDeviceSection } from "./ConnectDeviceSection";
import { BaskulePage, PageMessage, PageRow, PageSection } from "./BaskulePage";

const PLATFORM_LABELS: Record<Download["platform"], string> = {
  get linux() {
    return t("Linux");
  },
  get windows() {
    return t("Windows");
  },
  macos: "macOS",
  get android() {
    return t("Android");
  },
  get other() {
    return t("File");
  },
};

export function visitorPlatform(userAgent: string): Download["platform"] | null {
  if (/android/i.test(userAgent)) return "android";
  if (/windows/i.test(userAgent)) return "windows";
  if (/mac os x|macintosh/i.test(userAgent)) return "macos";
  if (/linux|x11/i.test(userAgent)) return "linux";
  return null;
}

/** The visitor's platform first, then the others in a stable order. */
export function orderDownloads(
  downloads: ReadonlyArray<Download>,
  platform: Download["platform"] | null,
): ReadonlyArray<Download> {
  const order: ReadonlyArray<Download["platform"]> = [
    "linux",
    "windows",
    "macos",
    "android",
    "other",
  ];
  return [...downloads].toSorted((left, right) => {
    if (platform !== null && (left.platform === platform) !== (right.platform === platform)) {
      return left.platform === platform ? -1 : 1;
    }
    return order.indexOf(left.platform) - order.indexOf(right.platform);
  });
}

export function DownloadsView() {
  const t = useTranslation();
  const info = useApiResource(baskuleApi.downloads);
  const platform = visitorPlatform(navigator.userAgent);
  const downloads = orderDownloads(info.data ?? [], platform);
  const version = downloads.find((download) => download.version !== null)?.version ?? null;
  return (
    <BaskulePage title={t("Apps")}>
      <ConnectDeviceSection />
      <PageSection
        title={version ? t("Apps · version {{version}}", { version: version }) : t("Apps")}
        description={t("The desktop app keeps you signed in and opens Baskule in its own window.")}
      >
        {info.error && downloads.length === 0 ? <PageMessage>{info.error}</PageMessage> : null}
        {info.loading && !info.data ? (
          <PageMessage>
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" tone="muted" />
              {t("Loading…")}
            </span>
          </PageMessage>
        ) : null}
        {info.data && downloads.length === 0 ? (
          <PageMessage>{t("No app was published with this installation yet.")}</PageMessage>
        ) : null}
        {downloads.map((download, index) => {
          const size = formatBytes(download.sizeBytes);
          const primary = index === 0 && download.platform === platform;
          return (
            <PageRow
              key={download.id}
              trailing={
                <Button
                  size="sm"
                  variant={primary ? "default" : "outline"}
                  render={<a href={download.url} download />}
                >
                  <DownloadIcon />
                  {t("Download")}
                </Button>
              }
            >
              <span className="truncate text-sm text-foreground">
                {download.label}
                {primary ? (
                  <span className="text-muted-foreground"> {t("· for this computer")}</span>
                ) : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {PLATFORM_LABELS[download.platform]} · {download.format}
                {size ? ` · ${size}` : ""}
                <span className="max-sm:hidden"> · {download.fileName}</span>
              </span>
            </PageRow>
          );
        })}
      </PageSection>
    </BaskulePage>
  );
}
