#!/usr/bin/env bash
# Record the public source, run, and byte-for-byte artifact identities.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
directory=${1:?artifact directory required}
kind=${2:?artifact kind required}
: "${BASKULE_VERSION:?release version required}"
mkdir -p "$directory"
cp source-provenance.json "$directory/"
mkdir -p "$directory/licenses"
cp LICENSE THIRD_PARTY_NOTICES.md "$directory/licenses/"
cp app/LICENSE "$directory/licenses/T3-LICENSE"
cp vendor/openshell/LICENSE "$directory/licenses/OpenShell-LICENSE"
cp vendor/openshell/THIRD-PARTY-NOTICES "$directory/licenses/OpenShell-THIRD-PARTY-NOTICES"
python3 - "$directory" "$kind" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

directory = Path(sys.argv[1])
provenance = {
    "version": os.environ["BASKULE_VERSION"],
    "kind": sys.argv[2],
    "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "repository": os.environ.get("GITHUB_REPOSITORY"),
    "run": f'{os.environ.get("GITHUB_SERVER_URL", "https://github.com")}/{os.environ.get("GITHUB_REPOSITORY", "")}/actions/runs/{os.environ.get("GITHUB_RUN_ID", "")}',
    "runner": {"os": os.environ.get("RUNNER_OS"), "architecture": os.environ.get("RUNNER_ARCH")},
    "toolchains": {"node": "26.12.1", "rust": "1.95.0"},
    "signing": "unsigned",
}
if sys.argv[2] == "backend":
    provenance["toolchains"].update({"z3": "5.1.0", "celld": "0.6.3"})
(directory / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
PY
(cd "$directory" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS && sha256sum -c SHA256SUMS)
