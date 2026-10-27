"""Exercise the privilege boundary without Docker, network access or root."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('deploy.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = 'a' * 40


class DeploymentGateTests(unittest.TestCase):
    def setUp(self):
        container = patch.object(gate, 'previous_build_exists', return_value=False)
        container.start()
        self.addCleanup(container.stop)

    def test_cancelled_job_cannot_leave_an_overlapping_build(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(gate, 'BASE', Path(directory)), \
                 patch.object(gate, 'previous_build_exists', return_value=True), \
                 patch.object(gate, 'git') as git, patch.object(gate, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'previous main build'):
                    gate.deploy(SHA)
                git.assert_not_called()
                run.assert_not_called()

    def test_rejects_refs_options_and_shell_input_before_any_io(self):
        for value in ('main', '--help', SHA + ';id', '../src', 'A' * 40, SHA + '\n'):
            with self.subTest(value=value), patch.object(gate, 'git') as git:
                with self.assertRaises(ValueError):
                    gate.deploy(value)
                git.assert_not_called()

    def test_stale_or_branch_commit_cannot_checkout_or_run_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(gate, 'BASE', Path(directory)), \
                 patch.object(gate, 'git', side_effect=['', 'b' * 40]) as git, \
                 patch.object(gate, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'canonical main'):
                    gate.deploy(SHA)
                self.assertEqual(git.call_args_list[0].args,
                                 ('fetch', '--quiet', '--depth=1', gate.REPO, 'refs/heads/main'))
                self.assertEqual(git.call_count, 2)
                run.assert_not_called()

    def test_trusted_main_uses_only_root_checkout_and_fixed_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            context = base / 'src/deploy/v2/build-env'
            context.mkdir(parents=True)
            (context / 'Dockerfile').write_text('FROM ubuntu:24.04')
            (context / 'run.sh').write_text('true')
            with patch.object(gate, 'BASE', base), patch.object(gate, 'SRC', base / 'src'), \
                 patch.object(gate, 'git', side_effect=['', SHA, '', '']) as git, \
                 patch.object(gate, 'run') as run:
                gate.deploy(SHA)
                self.assertEqual(git.call_args_list[2].args,
                                 ('checkout', '--quiet', '--force', '--detach', SHA))
                self.assertEqual(run.call_args_list[0].args[-1], str(context))
                self.assertEqual(run.call_args_list[1].args[:3], ('/usr/bin/docker', 'run', '--rm'))
                self.assertEqual(run.call_args_list[2].args,
                                 ('/usr/bin/timeout', '--kill-after=30', '600', '/usr/bin/bash',
                                  str(base / 'src/deploy/v2/runner/seed-ci-images.sh')))
                # The application was already deployed: a CI-only failure must not mark it failed.
                run.reset_mock()
                run.side_effect = [None, None, gate.subprocess.CalledProcessError(1, 'seed')]
                git.side_effect = ['', SHA, '', '']
                with patch('builtins.print') as warning:
                    gate.deploy(SHA)
                    self.assertIn('CI image sync failed', warning.call_args.args[0])
                self.assertEqual(run.call_count, 3)

    def test_job_environment_does_not_reach_privileged_commands(self):
        with patch.dict('os.environ', {'DOCKER_HOST': 'tcp://attacker:2375',
                                      'GIT_SSH_COMMAND': 'malicious', 'BASH_ENV': '/tmp/attack'}), \
             patch.object(gate.subprocess, 'run') as command:
            gate.run('/usr/bin/docker', 'info')
            environment = command.call_args.kwargs['env']
            self.assertNotIn('DOCKER_HOST', environment)
            self.assertNotIn('BASH_ENV', environment)
            self.assertNotIn('malicious', environment['GIT_SSH_COMMAND'])

    def test_git_failure_cannot_start_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(gate, 'BASE', Path(directory)), \
                 patch.object(gate, 'git', side_effect=gate.subprocess.CalledProcessError(1, 'git')), \
                 patch.object(gate, 'run') as run:
                with self.assertRaises(gate.subprocess.CalledProcessError):
                    gate.deploy(SHA)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
