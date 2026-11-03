import { isIP } from "node:net";

export const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4", "0.0.0.0/8"];

/** INPUT is required too: packets addressed to the host never traverse DOCKER-USER. */
export function guardScript(subnets: string[]): string {
  if (!subnets.length) throw new Error("Computer guard: network has no subnets");
  const lines = ["set -eu", "iptables -w -S DOCKER-USER >/dev/null 2>&1 || { echo 'Computer guard requires Docker iptables DOCKER-USER; nftables-only Docker is unsupported' >&2; exit 1; }"];
  for (const subnet of subnets) {
    const [address, prefix, extra] = subnet.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined || !/^\d+$/.test(prefix ?? "") || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error("Computer guard: invalid subnet");
    const tool = family === 4 ? "iptables" : "ip6tables";
    lines.push(`${tool} -w -S DOCKER-USER >/dev/null`);
    const tag = `baskule-computer-guard:${subnet}`;
    const rules = [
      `INPUT -s ${subnet} -m comment --comment ${tag} -j DROP`,
      `DOCKER-USER -s ${subnet} -m addrtype --dst-type LOCAL -m comment --comment ${tag} -j DROP`,
      ...(family === 4 ? privateRanges : ["fc00::/7", "fe80::/10", "::1/128", "ff00::/8"]).map(range => `DOCKER-USER -s ${subnet} -d ${range} -m comment --comment ${tag} -j DROP`),
    ];
    // Host VPN chains can accept forwarding before Docker reaches DOCKER-USER.
    rules.push(...rules.filter(rule => rule.startsWith("DOCKER-USER ")).map(rule => rule.replace("DOCKER-USER ", "FORWARD ")));
    for (const rule of rules) lines.push(`${tool} -w -C ${rule} 2>/dev/null || ${tool} -w -I ${rule}`, `${tool} -w -C ${rule}`);
  }
  return lines.join("\n");
}
