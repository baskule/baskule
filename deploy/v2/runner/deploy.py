#!/usr/bin/python3 -I
"""Root-owned sudo entry point: deploy only the current main of the canonical repository.

The Actions runner has no Docker access, credentials or writable deployment files. All
environment variables, workspaces, refs and commands supplied by jobs are untrusted.
Install this file as /usr/local/sbin/baskule-deploy (root:root, 0755).
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys

BASE = Path('/opt/baskule')
SRC = BASE / 'src'
REPO = 'git@github.com:baskule/baskule.git'
ENV = {
    'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'LANG': 'C.UTF-8',
    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_SSH_COMMAND': 'ssh -i /opt/baskule/deploy-key -o IdentitiesOnly=yes '
                       '-o StrictHostKeyChecking=yes '
                       '-o UserKnownHostsFile=/opt/baskule/cache/known_hosts',
}


def run(*args):
    return subprocess.run(args, cwd=BASE, env=ENV, check=True)


def git(*args):
    return subprocess.check_output(
        ['/usr/bin/git', '-C', str(SRC), '-c', 'core.hooksPath=/dev/null',
         '-c', 'core.fsmonitor=false', *args], cwd=BASE, env=ENV, text=True,
    ).strip()


def previous_build_exists():
    # A killed job may release flock while its Docker container continues. Never change that checkout.
    return bool(subprocess.check_output(
        ['/usr/bin/docker', 'container', 'ls', '--all', '--quiet',
         '--filter', 'name=^/baskule-main-build$'], cwd=BASE, env=ENV, text=True,
    ).strip())


def deploy(sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('expected one full lowercase commit SHA')
    # This lock covers checkout, build and deploy, including calls made outside Actions.
    with (BASE / 'deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if previous_build_exists():
            raise ValueError('a previous main build container still exists; inspect it before retrying')
        git('fetch', '--quiet', '--depth=1', REPO, 'refs/heads/main')
        if git('rev-parse', 'FETCH_HEAD') != sha:
            raise ValueError('refusing a commit that is not current canonical main')
        git('checkout', '--quiet', '--force', '--detach', sha)
        # Preserve ignored configuration and build caches; the runner cannot write here.
        git('clean', '--quiet', '-ffd')
        context = SRC / 'deploy/v2/build-env'
        digest = hashlib.sha256()
        for name in ('Dockerfile', 'run.sh'):
            digest.update((context / name).read_bytes())
        image = 'baskule-build:src-' + digest.hexdigest()[:16]
        run('/usr/bin/docker', 'build', '--network=host', '--tag', image, str(context))
        # Bind paths match the host: Compose resolves its own bind mounts through the host daemon.
        run('/usr/bin/docker', 'run', '--rm', '--name', 'baskule-main-build',
            '--network=host', '--pid=host',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--volume', '/opt/baskule:/opt/baskule',
            '--workdir', str(SRC), image)
        # CI is a consumer of deployed images; its availability must not block the served application.
        try:
            run('/usr/bin/timeout', '--kill-after=30', '600', '/usr/bin/bash',
                str(SRC / 'deploy/v2/runner/seed-ci-images.sh'))
        except subprocess.CalledProcessError:
            print('::warning::CI image sync failed; staging deployed, rootless component checks need an operator retry.')


def main():
    if os.geteuid() != 0:
        raise ValueError('this entry point must be installed and run as root')
    if len(sys.argv) != 2:
        raise ValueError('usage: baskule-deploy <main SHA>')
    deploy(sys.argv[1])


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'[deploy] {error}', file=sys.stderr)
        sys.exit(1)
