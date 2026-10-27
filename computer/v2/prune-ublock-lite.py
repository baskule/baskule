"""Keeps only the uBlock Origin Lite rulesets the computer uses (image build step; argv[1] = the unpacked extension).

Chromium loads an unpacked extension from disk at every browser start; the release ships ~60 rulesets (900+ files),
most of them disabled regional lists, plus dashboard assets: ~2.5 s added to each browser start in the sandbox. The
remaining rulesets are all enabled in the manifest, so no managed policy is needed to turn them on.
"""
import json
import os
import shutil
import sys

KEEP = {
    "ublock-filters", "easylist", "easyprivacy", "pgl", "ublock-badware", "urlhaus-full",
    "annoyances-cookies", "fra-0",
}

root = sys.argv[1]
manifest_path = os.path.join(root, "manifest.json")
manifest = json.load(open(manifest_path))
resources = manifest["declarative_net_request"]["rule_resources"]
manifest["declarative_net_request"]["rule_resources"] = [
    {**r, "enabled": True} for r in resources if r["id"] in KEEP
]
json.dump(manifest, open(manifest_path, "w"), separators=(",", ":"))

details_path = os.path.join(root, "rulesets", "ruleset-details.json")
details = json.load(open(details_path))
json.dump([d for d in details if d.get("id") in KEEP], open(details_path, "w"), separators=(",", ":"))

removed = 0
for folder, dirs, files in os.walk(os.path.join(root, "rulesets")):
    for name in files:
        stem = name.split(".")[0]
        if folder == os.path.join(root, "rulesets") or stem in KEEP:
            continue
        # Only files named after a ruleset are per-list data; shared files (details, regex index) stay.
        if any(stem == r["id"] for r in resources):
            os.remove(os.path.join(folder, name))
            removed += 1
    for name in list(dirs):
        if name in {r["id"] for r in resources} and name not in KEEP:
            shutil.rmtree(os.path.join(folder, name))
            dirs.remove(name)
            removed += 1
# Dashboard-only assets nobody sees in a headless browser: flag images and the UI translations (the default locale
# and French stay).
shutil.rmtree(os.path.join(root, "img", "flags-of-the-world"), ignore_errors=True)
locales = os.path.join(root, "_locales")
for name in os.listdir(locales):
    if name not in {manifest.get("default_locale", "en"), "fr"}:
        shutil.rmtree(os.path.join(locales, name))
print(f"kept {len(KEEP)} rulesets, removed {removed} ruleset files/dirs")
