#!/usr/bin/env python3
"""Hash versionable files under a directory, optionally limited by Git pathspecs."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
names = subprocess.check_output([
    'git', '-C', str(root), 'ls-files', '--cached', '--others',
    '--exclude-standard', '-z', '--', *(sys.argv[2:] or ['.']),
]).split(b'\0')
digest = hashlib.sha256()
for raw in sorted(set(names) - {b''}):
    path = root / os.fsdecode(raw)
    # Gitlinks are reference repositories, not build inputs. Deleted tracked files
    # are omitted so deletion changes the hash without failing the build.
    if not path.is_symlink() and not path.is_file():
        continue
    digest.update(raw + b'\0')
    if path.is_symlink():
        digest.update(b'link\0' + os.fsencode(os.readlink(path)))
    else:
        digest.update(b'executable\0' if path.stat().st_mode & 0o111 else b'file\0')
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
    digest.update(b'\0')
print(digest.hexdigest()[:16])
