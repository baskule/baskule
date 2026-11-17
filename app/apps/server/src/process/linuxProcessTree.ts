// @effect-diagnostics nodeBuiltinImport:off -- process ownership must be recorded synchronously.
import * as NodeFS from "node:fs";

export interface PosixProcessIdentity {
  readonly executable: string | undefined;
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  readonly sid: number;
  readonly state?: string;
  readonly startTime: string;
}

export interface PosixProcessTreeController {
  readonly childPidsOf: (pid: number) => ReadonlyArray<number>;
  readonly childrenOf: (pid: number) => ReadonlyArray<PosixProcessIdentity>;
  readonly identity: (pid: number) => PosixProcessIdentity | undefined;
  readonly snapshot: () => ReadonlyArray<PosixProcessIdentity>;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
}

function readLinuxProcessIdentity(pid: number): PosixProcessIdentity | undefined {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    // After comm: state, ppid, pgrp, session, … starttime (field 22 / index 19).
    const state = fields[0];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const sid = Number(fields[3]);
    const startTime = fields[19];
    if (
      state === undefined ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      !Number.isSafeInteger(sid) ||
      startTime === undefined
    ) {
      return undefined;
    }
    let executable: string | undefined;
    try {
      executable = NodeFS.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      executable = undefined;
    }
    return { executable, pgid, pid, ppid, sid, startTime, state };
  } catch {
    return undefined;
  }
}

/** Linux zombies keep pid/starttime until reaped; they are not live survivors. */
export function posixProcessIsZombie(process: PosixProcessIdentity): boolean {
  return process.state === "Z";
}

function readLinuxChildPids(pid: number): ReadonlyArray<number> {
  const childPids = new Set<number>();
  let taskIds: ReadonlyArray<string> = [];
  try {
    taskIds = NodeFS.readdirSync(`/proc/${pid}/task`).filter((entry) =>
      /^[1-9][0-9]*$/.test(entry),
    );
  } catch {
    return [];
  }
  for (const taskId of taskIds) {
    try {
      for (const childPid of NodeFS.readFileSync(`/proc/${pid}/task/${taskId}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)) {
        childPids.add(childPid);
      }
    } catch {}
  }
  return [...childPids];
}

export function makeLinuxProcessTreeController(): PosixProcessTreeController {
  return {
    childPidsOf: readLinuxChildPids,
    childrenOf: (pid) =>
      readLinuxChildPids(pid).flatMap((childPid) => {
        const identity = readLinuxProcessIdentity(childPid);
        return identity === undefined ? [] : [identity];
      }),
    identity: readLinuxProcessIdentity,
    snapshot: () =>
      // By name only: withFileTypes lstats entries, which throws when a process exits mid-scan.
      NodeFS.readdirSync("/proc").flatMap((entry) => {
        if (!/^[1-9][0-9]*$/.test(entry)) return [];
        const identity = readLinuxProcessIdentity(Number(entry));
        return identity === undefined ? [] : [identity];
      }),
    signalProcess: (pid, signal) => process.kill(pid, signal),
  };
}
