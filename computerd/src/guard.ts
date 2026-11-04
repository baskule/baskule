import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4", "0.0.0.0/8"];

export function guardChain(subnets: string[]): string {
  return `BASKULE-${createHash("sha256").update([...new Set(subnets)].sort().join(",")).digest("hex").slice(0, 16)}`;
}

/** Each subnet set owns its chain, so independent installations cannot flush each other. */
export function guardScript(subnets: string[]): string {
  if (!subnets.length) throw new Error("Computer guard: network has no subnets");
  for (const subnet of subnets) {
    const [address, prefix, extra] = subnet.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined || !/^\d+$/.test(prefix ?? "") || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error("Computer guard: invalid subnet");
  }
  const chain = guardChain(subnets);
  const lines = ["set -eu"];
  for (const family of [4, 6]) {
    const sources = [...new Set(subnets)].sort().filter(subnet => isIP(subnet.split("/")[0]) === family);
    if (!sources.length) continue;
    const tool = family === 4 ? "iptables" : "ip6tables";
    lines.push(`${tool} -w -S DOCKER-USER >/dev/null`, `${tool} -w -S ${chain} >/dev/null 2>&1 || ${tool} -w -N ${chain}`);
    // Restore commits the replacement chain in one transaction, preserving other chains.
    lines.push(`${tool}-restore -w --noflush <<'GUARD'`, "*filter", `-F ${chain}`,
      `-A ${chain} -m addrtype --dst-type LOCAL -j DROP`,
      ...(family === 4 ? privateRanges : ["fc00::/7", "fe80::/10", "::1/128", "ff00::/8"]).map(range => `-A ${chain} -d ${range} -j DROP`), "COMMIT", "GUARD");
    for (const parent of ["DOCKER-USER", "FORWARD", "INPUT"]) {
      // Our jumps must sit in the leading block of guard jumps, ahead of any other rule (a VPN's ACCEPT, for
      // example). Other installations' guard jumps may share that block, so they never fight over position 1.
      // Insert first, then drop later duplicates, so the subnet is never unguarded in between.
      const jumps = sources.map(subnet => `-A ${parent} -s ${subnet} -j ${chain}`);
      lines.push(`leading=$(${tool} -w -S ${parent} | grep '^-A ' | awk '!/ -j BASKULE-[0-9a-f]+$/ { exit } { print }')`);
      lines.push(`if ! { ${jumps.map(jump => `printf '%s\\n' "$leading" | grep -qxF -- '${jump}'`).join(" && ")}; }; then`);
      for (const subnet of [...sources].reverse()) lines.push(`${tool} -w -I ${parent} 1 -s ${subnet} -j ${chain}`);
      lines.push("fi");
      for (const jump of jumps) {
        lines.push(`${tool} -w -S ${parent} | awk -v rule='${jump}' '/^-A / { n++ } $0 == rule && ++seen > 1 { print n }' | sort -rn | while read -r n; do ${tool} -w -D ${parent} "$n"; done`);
      }
      for (const subnet of sources) {
        // Delete only legacy rules carrying this exact subnet's tag, by rule number.
        lines.push(`${tool} -w -S ${parent} | awk '/^-A / { n++ } /--comment "?baskule-computer-guard:${subnet.replaceAll(".", "\\.").replaceAll("/", "\\/")}"? / { print n }' | sort -rn | while read -r n; do ${tool} -w -D ${parent} "$n"; done`);
      }
    }
  }
  return lines.join("\n");
}
