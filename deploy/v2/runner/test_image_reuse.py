"""Run images.sh against a temporary Git tree and a recording Docker double."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class ImageReuseTests(unittest.TestCase):
    def test_only_changed_image_inputs_build_and_reverts_reuse_cached_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'repo'
            root.mkdir()
            for name in ('deploy/v2/images.sh', 'deploy/v2/lib.sh', 'scripts/source-hash.py',
                         'deploy/v2/build-env/Dockerfile', 'computer/v2/input', 'openshell/input',
                         'vendor/openshell/input', 'deploy/v2/celld/input', 'computerd/v2/input',
                         'app/browser-source', 'app/unrelated-ui'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                source = ROOT / name
                path.write_bytes(source.read_bytes() if source.is_file() else b'original')
            (root / '.gitignore').write_text('computer/v2/browser/\n')
            for folder, image in (('computer/v2', 'computer'), ('openshell', 'openshell-gateway')):
                script = root / folder / 'build.sh'
                script.write_text(f'#!/bin/bash\nexec docker build -t baskule-{image}:${{BASKULE_TAG:-0.2}} .\n')
                script.chmod(0o755)
            binaries = base / 'bin'
            binaries.mkdir()
            node = binaries / 'node'
            node.write_text('#!/bin/bash\nmkdir -p computer/v2/browser\ncp app/browser-source computer/v2/browser/bridge.mjs\n')
            node.chmod(0o755)
            docker = binaries / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['DOCKER_TEST_STATE'])
s = json.loads(p.read_text()) if p.exists() else {'images': {}, 'builds': []}
a = sys.argv[1:]
if a[:2] == ['image', 'inspect']:
    identity = s['images'].get(a[-1])
    if identity is None: sys.exit(1)
    print(identity)
elif a[0] == 'tag': s['images'][a[2]] = s['images'][a[1]]
elif a[0] == 'build':
    image = a[a.index('-t') + 1]
    s['builds'].append(image)
    s['images'][image] = 'id-' + str(len(s['builds']))
else: raise AssertionError(a)
p.write_text(json.dumps(s))
''')
            docker.chmod(0o755)
            environment = {**os.environ, 'PATH': f'{binaries}:{os.environ["PATH"]}',
                           'DOCKER_TEST_STATE': str(base / 'docker.json'),
                           'DOCKER_CONFIG': str(base / 'docker-config')}
            subprocess.run(['git', 'init', '-q', str(root)], check=True)

            def images():
                subprocess.run(['bash', 'deploy/v2/images.sh'], cwd=root, env=environment,
                               check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                return json.loads((base / 'docker.json').read_text())['builds']

            first = images()
            self.assertEqual(len(first), 4)
            self.assertEqual(images(), first, 'identical inputs must not rebuild anything')
            (root / 'app/unrelated-ui').write_text('a UI-only edit')
            self.assertEqual(images(), first, 'unrelated fork edits must not rebuild computers')
            (root / 'app/browser-source').write_text('a browser bridge edit')
            changed = images()
            self.assertEqual(changed, first + ['baskule-computer:0.2'])
            (root / 'app/browser-source').write_text('original')
            self.assertEqual(images(), changed, 'reverting must reuse the original source-tagged image')
            (root / 'deploy/v2/build-env/Dockerfile').write_text('a different native toolchain')
            changed = changed + ['baskule-openshell-gateway:0.2']
            self.assertEqual(images(), changed)
            environment['BASKULE_TAG'] = 'validation'
            self.assertEqual(images(), changed + ['baskule-openshell-gateway:validation'],
                             'the embedded image tags are gateway build inputs')


if __name__ == '__main__':
    unittest.main()
