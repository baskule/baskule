/** Only development builds carry a stage badge; installed builds show the plain brand. */
export function resolveMobileStageLabel(appVariant: unknown): "Dev" | null {
  return appVariant === "development" ? "Dev" : null;
}
