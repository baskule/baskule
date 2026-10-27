// baskule: the loading, error and empty states of an admin list.
import { useTranslation } from "../../i18n";
import { Spinner } from "../../components/ui/spinner";
import { PageMessage } from "../views/BaskulePage";

export function ResourceState({
  error,
  loading,
  empty,
  emptyText,
}: {
  readonly error: string | null;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly emptyText: string;
}) {
  const t = useTranslation();
  if (error && empty) return <PageMessage>{error}</PageMessage>;
  if (loading && empty) {
    return (
      <PageMessage>
        <span className="inline-flex items-center gap-2">
          <Spinner size="sm" tone="muted" />
          {t("Loading…")}
        </span>
      </PageMessage>
    );
  }
  if (empty) return <PageMessage>{emptyText}</PageMessage>;
  return null;
}
