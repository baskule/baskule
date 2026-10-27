// baskule: AI → Usage & limits: the organization's usage, then the per-person limits.
import { LimitsEditor } from "./LimitsEditor";
import { UsageDashboard } from "./UsageDashboard";

export function UsageLimitsPage() {
  return (
    <>
      <UsageDashboard />
      <LimitsEditor />
    </>
  );
}
