// A full component loop covers its named selections. Unknown commands always survive.
export const releaseCoverage = ["worker", "space", "agent", "computerd", "features", "web", "desktop", "kubernetes"];
export function remainingFeatureChecks(feature, covered = []) {
  return (feature.checks ?? []).flatMap((command) => {
    if (command === "desktop/check.sh" && covered.includes("desktop")) return [];
    if (!/^scripts\/check(?: [a-z][a-z0-9:-]*)+$/.test(command)) return [command];
    const targets = command.slice("scripts/check ".length).split(" ")
      .filter((target) => !covered.includes(target.split(":")[0]));
    return targets.length ? [`scripts/check ${targets.join(" ")}`] : [];
  });
}
export function releaseFeatures(map, shard = "1/1") {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
  if (!match || +match[1] > +match[2]) throw new Error("Expected --shard N/M with 1 <= N <= M");
  return map.filter((feature) => !feature.ownerRun && (feature.journeys || remainingFeatureChecks(feature, releaseCoverage).length))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((_, index) => index % +match[2] === +match[1] - 1);
}
