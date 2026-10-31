import { createHash } from "node:crypto";

// The computer's OpenShell policy (architecture E5), as a SandboxPolicy proto object.
// Mirror of openshell/policies/computer.yaml (a unit test checks they agree).
export function computerPolicy() {
  return {
    version: 1,
    filesystem: {
      include_workdir: true,
      read_only: ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/opt", "/proc", "/sys", "/dev/urandom", "/var/log", "/var/lib"],
      read_write: ["/tmp", "/var/tmp", "/dev/null", "/dev/shm"],
    },
    landlock: { compatibility: "best_effort" },
    process: { run_as_user: "1000", run_as_group: "1000" },
    network_policies: {
      internet: {
        name: "internet",
        endpoints: [
          {
            // Field 28, only in our fork: any globally routable public unicast address, private ranges never.
            public_internet: true,
            ports: [80, 443, 22],
            tls: "NETWORK_TLS_MODE_SKIP",
          },
        ],
        binaries: [{ path: "/**" }],
      },
    },
  };
}

/** Space IDs accepted by the API. */
export const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * OpenShell sandbox names are DNS-1123 labels of at most 19 characters. `os-<spaceId>` when it fits,
 * otherwise `os-` + 16 hex chars of sha256(spaceId). Scoped names hash the encoded instance/space pair
 * to avoid ambiguous separators and fit both name limits. The per-space volume uses the same suffix.
 */
export function namesFor(spaceId: string, instance = ""): { sandbox: string; volume: string } {
  let suffix = spaceId;
  if (instance || !/^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$/.test(spaceId)) {
    suffix = createHash("sha256").update(instance ? JSON.stringify([instance, spaceId]) : spaceId).digest("hex").slice(0, 16);
  }
  return { sandbox: `os-${suffix}`, volume: `baskule-space-${suffix}` };
}
