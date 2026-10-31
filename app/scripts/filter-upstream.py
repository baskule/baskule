#!/usr/bin/env python3
"""Prepare an upstream tree with selected PRs reversed, stopping for human conflict review."""

import argparse
import json
from pathlib import Path
import re
import subprocess


def git(repo, *args, check=True):
    return subprocess.run(
        ["git", "-c", "gc.auto=0", "-C", str(repo), *args],
        check=check, capture_output=True, text=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--from-ref", required=True)
    parser.add_argument("--to-ref", required=True)
    parser.add_argument("--exclude-pr", type=int, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    output = args.output.resolve()
    if output.exists():
        parser.error("--output must not exist; existing resolutions are never overwritten")
    start = git(upstream, "rev-parse", "--verify", f"{args.from_ref}^{{commit}}").stdout.strip()
    end = git(upstream, "rev-parse", "--verify", f"{args.to_ref}^{{commit}}").stdout.strip()
    log = git(upstream, "log", "--first-parent", "--format=%H%x09%s", f"{start}..{end}")
    selected = []
    missing = set(args.exclude_pr)
    for line in log.stdout.splitlines():
        sha, subject = line.split("\t", 1)
        match = re.search(r"\(#(\d+)\)$", subject)
        if match and int(match[1]) in args.exclude_pr:
            pr = int(match[1])
            missing.discard(pr)
            selected.append({"commit": sha, "pr": pr, "subject": subject})
    if missing:
        parser.error(f"PRs absent from the selected first-parent range: {sorted(missing)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "-c", "gc.auto=0", "clone", "--shared", "--no-checkout", str(upstream), str(output)],
        check=True, capture_output=True,
    )
    git(output, "remote", "remove", "origin")
    git(output, "checkout", "--detach", end)
    # Git retains all three stages and its sequencer when a reverse patch conflicts.
    result = git(output, "revert", "--no-commit", "--mainline", "1",
                 *(entry["commit"] for entry in selected), check=False)
    conflicts = git(output, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
    manifest = {"from": start, "to": end, "reversed": selected, "conflicts": conflicts}
    (output / ".git" / "baskule-filter.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    if result.returncode:
        print(result.stderr)
        print("Review each conflict in the output checkout; keep unrelated later changes. "
              "Stage resolutions and run git revert --continue there. No conflict side is chosen automatically.")
        return 2
    print("Filtered changes are staged in the output checkout. Review before using them as a merge input.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
