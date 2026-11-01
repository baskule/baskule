"""Exercise workload reconciliation after the host image was already retagged."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ComputerReconciliationTests(unittest.TestCase):
    def reconcile(self, computers, desired='sha256:current'):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for name in ('deploy/recreate-computers.sh', 'deploy/lib.sh'):
                destination = base / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((ROOT / name).read_bytes())
            load = base / 'openshell/load-images.sh'
            load.parent.mkdir()
            load.write_text('#!/bin/bash\nexit 0\n')
            load.chmod(0o755)
            binaries = base / 'bin'
            binaries.mkdir()
            docker = binaries / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
path = pathlib.Path(os.environ['RECONCILE_STATE'])
state = json.loads(path.read_text())
args = sys.argv[3:]
if args[:3] == ['docker', 'image', 'inspect']:
    if state['desired'] is None: sys.exit(1)
    print(state['desired'])
elif args[:2] == ['docker', 'ps']:
    print(' '.join(c['id'] for c in state['computers']))
elif args[:2] == ['docker', 'inspect']:
    for ident in args[4:]:
        c = next(c for c in state['computers'] if c['id'] == ident)
        print(c['image'], c['name'])
elif args[0] == 'openshell' and 'delete' in args:
    state['deleted'].append(args[-1])
    path.write_text(json.dumps(state))
else: raise AssertionError(args)
''')
            docker.chmod(0o755)
            state = base / 'state.json'
            state.write_text(json.dumps({'desired': desired, 'computers': computers, 'deleted': []}))
            result = subprocess.run(['bash', 'deploy/recreate-computers.sh', '--outdated'], cwd=base,
                                    env={**os.environ, 'PATH': f'{binaries}:{os.environ["PATH"]}',
                                         'DOCKER_CONFIG': str(base / 'docker-config'),
                                         'RECONCILE_STATE': str(state), 'BASKULE_TAG': 'local'},
                                    capture_output=True, text=True)
            return result.returncode, json.loads(state.read_text())['deleted']

    def test_already_built_host_image_still_updates_only_stale_workloads(self):
        self.assertEqual(self.reconcile([
            {'id': 'old', 'image': 'sha256:old', 'name': 'os-old'},
            {'id': 'current', 'image': 'sha256:current', 'name': 'os-current'},
        ]), (0, ['os-old']))

    def test_current_workloads_and_empty_fleet_are_untouched(self):
        self.assertEqual(self.reconcile([
            {'id': 'current', 'image': 'sha256:current', 'name': 'os-current'},
        ]), (0, []))
        self.assertEqual(self.reconcile([]), (0, []))

    def test_missing_desired_image_cannot_delete_workloads(self):
        result, deleted = self.reconcile([
            {'id': 'old', 'image': 'sha256:old', 'name': 'os-old'},
        ], desired=None)
        self.assertNotEqual(result, 0)
        self.assertEqual(deleted, [])


if __name__ == '__main__':
    unittest.main()
