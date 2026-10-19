import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_pos', Path(__file__).parents[1] / 'scripts/deploy-pos.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
PROJECT = 'dbdtluvsdqycxl5tecuwljie'
VERSION = '20261015120000'
NEW_VERSION = '20261019120000'
CONFIG = {
    'coolify_project': PROJECT, 'docker_network': PROJECT, 'db_user': 'supabase_admin',
    'db_name': 'postgres', 'supabase_bin': '/usr/bin/supabase', 'supabase_version': '2.121.0',
    'required_migration': VERSION,
}


def package(entries=None, **manifest):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        value = {'protocol': 2, 'coolify_project': PROJECT, 'commit': 'a' * 40, **manifest}
        contents = json.dumps(value).encode()
        header = tarfile.TarInfo('deployment.json')
        header.size = len(contents)
        archive.addfile(header, io.BytesIO(contents))
        for entry in entries if entries is not None else [f'migrations/{VERSION}_example.sql']:
            header = entry if isinstance(entry, tarfile.TarInfo) else tarfile.TarInfo(entry)
            header.size = 8 if header.isfile() else 0
            archive.addfile(header, io.BytesIO(b'select 1'))
    output.seek(0)
    return output


class FakeRunner:
    def __init__(self, *, before=None, after=None, fail=None):
        self.before = before if before is not None else [VERSION]
        self.after = after if after is not None else [VERSION, NEW_VERSION]
        self.applied = False
        self.calls = []
        self.secrets = []
        self.fail = fail

    def command(self, args, **options):
        self.calls.append((args, options))
        if args[-1] == '--version':
            return '2.121.0'
        if args[:2] == ['docker', 'ps']:
            return 'coolify-db-id'
        if args[:2] == ['docker', 'inspect']:
            return '10.0.5.6'
        if 'psql' in args:
            if 'COPY' in args[-1]:
                return '\n'.join(self.after if self.applied else self.before)
            return ''
        if 'push' in args:
            if self.fail == 'dry-run':
                raise deploy.DeployError('TCP failed')
            if '--dry-run' not in args:
                self.applied = True
            return ''
        raise AssertionError(args)

    def backup(self, *args):
        self.calls.append((['backup'], {}))
        if self.fail == 'backup':
            raise deploy.DeployError('Invalid backup')


class ReceiverTests(unittest.TestCase):
    def unpack(self, source):
        with tempfile.TemporaryDirectory() as directory:
            return deploy.unpack_package(source, Path(directory), PROJECT)

    def test_valid_package_and_target_guard(self):
        manifest, versions = self.unpack(package())
        self.assertEqual(manifest['coolify_project'], PROJECT)
        self.assertEqual(versions, {VERSION})
        for invalid in ({'protocol': 1}, {'coolify_project': 'old-stack'}, {'commit': 'HEAD'}, {'commit': 42}, {'operation': 'reset'}):
            with self.subTest(invalid=invalid), self.assertRaises(deploy.DeployError):
                self.unpack(package(**invalid))

    def test_check_packages_require_a_protocol_rejected_by_old_apply_only_receivers(self):
        with self.assertRaises(deploy.DeployError):
            self.unpack(package(operation='check'))
        manifest, _ = self.unpack(package(protocol=3, operation='check'))
        self.assertEqual(manifest['operation'], 'check')
        self.unpack(package(protocol=3, operation='apply'))

    def test_paths_links_duplicates_and_empty_migrations_are_rejected(self):
        link = tarfile.TarInfo(f'migrations/{VERSION}_link.sql')
        link.type, link.linkname = tarfile.SYMTYPE, '/etc/passwd'
        cases = [
            ['migrations/../../escape.sql'], ['/etc/pos-deploy.json'], ['deploy.sh'],
            [f'migrations/nested/{VERSION}_example.sql'], [link], [],
            [f'migrations/{VERSION}_a.sql', f'migrations/{VERSION}_b.sql'],
            [f'migrations/{VERSION}_a.sql', f'migrations/{VERSION}_a.sql'],
        ]
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(deploy.DeployError):
                self.unpack(package(entries))

    def run_migration(self, runner, *, check_only=False):
        credential = subprocess.CompletedProcess([], 0, b'current-password:@/%\n', b'')
        with patch.object(deploy.subprocess, 'run', return_value=credential):
            return deploy.migrate(runner, CONFIG, Path('/project'), {VERSION, NEW_VERSION}, Path('/backup.dump'), check_only=check_only)

    def test_check_mode_only_reads_history_and_runs_readonly_dry_run(self):
        runner = FakeRunner()
        self.assertEqual(self.run_migration(runner, check_only=True), 1)
        self.assertFalse(runner.applied)
        calls = [args for args, _ in runner.calls]
        self.assertNotIn(['backup'], calls)
        self.assertFalse(any('NOTIFY' in args[-1] for args in calls))
        pushes = [(args, options) for args, options in runner.calls if 'push' in args]
        self.assertEqual(len(pushes), 1)
        self.assertIn('--dry-run', pushes[0][0])
        connection = pushes[0][0][pushes[0][0].index('--db-url') + 1]
        self.assertIn('&default_transaction_read_only=on', connection)

    def test_backup_precedes_apply_and_post_history_precedes_reload(self):
        runner = FakeRunner()
        self.assertEqual(self.run_migration(runner), 1)
        calls = [args for args, _ in runner.calls]
        push = next(index for index, args in enumerate(calls) if 'push' in args)
        self.assertLess(calls.index(['backup']), push)
        self.assertIn('--dry-run', calls[push])
        self.assertNotIn('--dry-run', calls[push + 1])
        self.assertIn('COPY', calls[-2][-1])
        self.assertEqual(calls[-1][-1], "NOTIFY pgrst, 'reload schema';")
        for args, options in runner.calls:
            self.assertNotIn('current-password', ' '.join(args))
            if 'push' in args:
                self.assertEqual(options['env']['PGPASSWORD'], 'current-password:@/%')
                self.assertEqual(options['env']['SUPABASE_DB_PASSWORD'], 'current-password:@/%')
                self.assertIn('--skip-vault', args)
                self.assertNotIn('--debug', args)

    def test_unknown_remote_history_and_missing_guard_stop_before_backup(self):
        for versions in ([VERSION, '20990101000000'], [], [NEW_VERSION]):
            runner = FakeRunner(before=versions)
            with self.subTest(versions=versions), self.assertRaises(deploy.DeployError):
                self.run_migration(runner)
            self.assertNotIn(['backup'], [args for args, _ in runner.calls])

    def test_invalid_backup_or_dry_run_never_applies(self):
        for stage in ('backup', 'dry-run'):
            runner = FakeRunner(fail=stage)
            with self.subTest(stage=stage), self.assertRaises(deploy.DeployError):
                self.run_migration(runner)
            self.assertFalse(runner.applied)

    def test_incomplete_history_does_not_report_success_or_reload(self):
        runner = FakeRunner(after=[VERSION])
        with self.assertRaises(deploy.DeployError):
            self.run_migration(runner)
        self.assertFalse(any('NOTIFY' in args[-1] for args, _ in runner.calls))

    def test_database_selection_is_bound_to_project_service_and_network(self):
        runner = FakeRunner()
        self.assertEqual(deploy.find_database(runner, CONFIG), ('coolify-db-id', '10.0.5.6'))
        self.assertIn(f'label=com.docker.compose.project={PROJECT}', runner.calls[0][0])
        self.assertIn('label=com.docker.compose.service=supabase-db', runner.calls[0][0])
        self.assertIn(f'"{PROJECT}"', runner.calls[1][0][-2])
        for output in ('', 'db-a\ndb-b'):
            runner.command = lambda *_args, **_kwargs: output
            with self.assertRaises(deploy.DeployError):
                deploy.find_database(runner, CONFIG)

    def test_backup_is_read_in_full_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'postgres.dump'
            runner = deploy.Runner(io.StringIO())
            calls = []

            def command(args, **options):
                calls.append(args)
                if 'pg_dump' in args:
                    options['stdout'].write(b'archive-content')
                elif '--file=/dev/null' in args:
                    raise deploy.DeployError('Corrupt archive')

            runner.command = command
            with self.assertRaises(deploy.DeployError):
                runner.backup('coolify-db-id', CONFIG, path)
            self.assertFalse(path.exists())
            self.assertTrue(path.with_suffix('.partial').exists())
            self.assertEqual(len(calls), 3)
            self.assertNotIn('--no-owner', calls[0])
            self.assertNotIn('--no-acl', calls[0])

    def test_remote_diagnostics_redact_the_database_password(self):
        log = io.StringIO()
        runner = deploy.Runner(log)
        runner.secrets = ['secret-password']
        result = subprocess.CompletedProcess([], 1, b'', b'failed for secret-password')
        with patch.object(deploy.subprocess, 'run', return_value=result):
            with self.assertRaises(deploy.DeployError) as failure:
                runner.command(['tool'])
        self.assertNotIn('secret-password', log.getvalue())
        self.assertIn('[REDACTED]', log.getvalue())
        self.assertNotIn('secret-password', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
