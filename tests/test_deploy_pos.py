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
            payload = entries[entry] if isinstance(entries, dict) else b'select 1'
            header = entry if isinstance(entry, tarfile.TarInfo) else tarfile.TarInfo(entry)
            header.size = len(payload) if header.isfile() else 0
            archive.addfile(header, io.BytesIO(payload))
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


class EdgeTests(unittest.TestCase):
    def entries(self, config=b'[functions.example]\nverify_jwt = false\n'):
        return {f'migrations/{VERSION}_example.sql': b'select 1', 'config.toml': config,
                'functions/main/index.ts': b'router', 'functions/deno.json': b'{"imports":{}}',
                'functions/example/index.ts': b'worker', 'functions/_shared/helper.ts': b'helper'}

    def test_protocol_four_is_complete_and_preserves_function_auth_and_import_map(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            manifest, versions = deploy.unpack_package(package(self.entries(), protocol=4, operation='check'), project, PROJECT)
            release = deploy.edge_release(project / 'supabase', manifest['commit'])
            self.assertEqual(versions, {VERSION})
            self.assertEqual(release['functions'], {'example': {'verify_jwt': False,
                'import_map': '/home/deno/functions/deno.json'}})
            (project / 'supabase/config.toml').write_text('')
            self.assertTrue(deploy.edge_release(project / 'supabase', manifest['commit'])['functions']['example']['verify_jwt'])

    def test_incomplete_or_unsafe_packages_and_unsupported_settings_are_rejected(self):
        cases = [self.entries(config=config) for config in (
            b'[functions.missing]\nverify_jwt=false', b'[functions.example]\nverify_jwt="false"',
            b'[functions.example]\nimport_map="../secrets.json"',
            b'[functions.example]\nentrypoint="other.ts"',
            b'[functions.example]\nimport_map="./functions/missing.json"',
        )]
        for path in ('functions/../escape.ts', 'functions/example/.env', 'functions/pos-release.json'):
            cases.append({**self.entries(), path: b'secret'})
        for missing in ('config.toml', 'functions/main/index.ts', 'functions/example/index.ts'):
            cases.append({key: value for key, value in self.entries().items() if key != missing})
        for entries in cases:
            with self.subTest(paths=list(entries)), tempfile.TemporaryDirectory() as directory, self.assertRaises((deploy.DeployError, FileNotFoundError)):
                deploy.unpack_package(package(entries, protocol=4), Path(directory), PROJECT)
        for protocol in (2, 3):
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(deploy.DeployError):
                deploy.unpack_package(package(self.entries(), protocol=protocol), Path(directory), PROJECT)

    def fixture(self, directory):
        project = directory / 'project'
        project.mkdir()
        deploy.unpack_package(package(self.entries(), protocol=4), project, PROJECT)
        root = directory / PROJECT / 'volumes/functions'
        (root / 'main').mkdir(parents=True)
        (root / 'main/index.ts').write_text('old router')
        (root / 'example').mkdir()
        (root / 'example/index.ts').write_text('old worker')
        (root / '_shared').mkdir()
        (root / '_shared/fiscal.ts').write_text('fiscal helper')
        (root / 'verifacti-webhook').mkdir()
        (root / 'verifacti-webhook/index.ts').write_text('fiscal webhook')
        metadata = {'image': 'supabase/edge-runtime:v1.76.2', 'command': [
            'start', '--user-worker-request-idle-timeout', '150000', '--main-service', deploy.EDGE_DESTINATION + '/main'],
            'mounts': [{'Type': 'bind', 'Source': str(root), 'Destination': deploy.EDGE_DESTINATION, 'RW': True},
                       {'Type': 'bind', 'Source': str(root / 'main/index.ts'), 'Destination': deploy.EDGE_DESTINATION + '/main/index.ts', 'RW': True}]}
        calls = []
        class EdgeRunner:
            def command(self, args, **_options):
                calls.append(args)
                if args[:2] == ['docker', 'ps']:
                    return 'abcdef1234'
                if args[:2] == ['docker', 'inspect']:
                    return json.dumps(metadata)
                if 'printenv' in args:
                    return 'false'
                return ''
        return project, root, metadata, calls, EdgeRunner()

    def test_preflight_preserves_vps_only_fiscal_functions_and_shared_helpers_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            project, root, _, calls, runner = self.fixture(directory)
            with patch.object(deploy, 'COOLIFY_SERVICES', directory):
                edge = deploy.prepare_edge(runner, {**CONFIG, 'edge_image': 'supabase/edge-runtime:v1.76.2'}, project, 'a' * 40)
            release = json.loads((edge['staged'] / 'pos-release.json').read_text())
            self.assertFalse(release['functions']['verifacti-webhook']['verify_jwt'])
            self.assertIsNone(release['functions']['verifacti-webhook']['import_map'])
            self.assertEqual((edge['staged'] / '_shared/fiscal.ts').read_text(), 'fiscal helper')
            self.assertEqual((root / 'main/index.ts').read_text(), 'old router')
            self.assertFalse(any(args[1] in ('start', 'stop') for args in calls))
            self.assertIn(f'label=com.docker.compose.project={PROJECT}', calls[0])
            self.assertIn('label=com.docker.compose.service=supabase-edge-functions', calls[0])

    def test_wrong_image_or_mount_stops_preflight(self):
        for invalid in ('image', 'mount', 'nested'):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                project, _, metadata, calls, runner = self.fixture(directory)
                if invalid == 'image':
                    metadata['image'] = 'other:latest'
                elif invalid == 'mount':
                    metadata['mounts'][0]['Source'] = '/other/environment/functions'
                else:
                    metadata['mounts'].append({'Destination': deploy.EDGE_DESTINATION + '/example', 'Type': 'volume'})
                with patch.object(deploy, 'COOLIFY_SERVICES', directory), self.assertRaises(deploy.DeployError):
                    deploy.prepare_edge(runner, {**CONFIG, 'edge_image': 'supabase/edge-runtime:v1.76.2'}, project, 'a' * 40)
                self.assertFalse(any(args[1] in ('start', 'stop') for args in calls))

    def test_later_releases_keep_auth_of_functions_removed_from_the_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            project, root, _, _, runner = self.fixture(directory)
            retained = {'verify_jwt': True, 'import_map': '/home/deno/functions/deno.json'}
            (root / 'pos-release.json').write_text(json.dumps({'functions': {'verifacti-webhook': retained}}))
            with patch.object(deploy, 'COOLIFY_SERVICES', directory):
                edge = deploy.prepare_edge(runner, {**CONFIG, 'edge_image': 'supabase/edge-runtime:v1.76.2'}, project, 'a' * 40)
            release = json.loads((edge['staged'] / 'pos-release.json').read_text())
            self.assertEqual(release['functions']['verifacti-webhook'], retained)

    def test_successful_deploy_preserves_bind_inodes_and_unmanaged_fiscal_endpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            project, root, _, calls, runner = self.fixture(directory)
            root_inode, main_inode = root.stat().st_ino, (root / 'main/index.ts').stat().st_ino
            with patch.object(deploy, 'COOLIFY_SERVICES', directory):
                edge = deploy.prepare_edge(runner, {**CONFIG, 'edge_image': 'supabase/edge-runtime:v1.76.2'}, project, 'a' * 40)
            with patch.object(deploy, 'probe_edge') as probe:
                deploy.deploy_edge(runner, CONFIG, edge, directory / 'backup')
            probe.assert_called_once()
            self.assertEqual(root_inode, root.stat().st_ino)
            self.assertEqual(main_inode, (root / 'main/index.ts').stat().st_ino)
            self.assertEqual((root / 'example/index.ts').read_text(), 'worker')
            self.assertEqual((root / '_shared/fiscal.ts').read_text(), 'fiscal helper')
            self.assertEqual((root / 'verifacti-webhook/index.ts').read_text(), 'fiscal webhook')
            self.assertEqual((directory / 'backup/main/index.ts').read_text(), 'old router')
            self.assertEqual([args[1] for args in calls if args[1] in ('stop', 'start')], ['stop', 'start'])

    def test_failed_boot_restores_old_code_and_removes_new_files_before_failing(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            project, root, _, calls, runner = self.fixture(directory)
            with patch.object(deploy, 'COOLIFY_SERVICES', directory):
                edge = deploy.prepare_edge(runner, {**CONFIG, 'edge_image': 'supabase/edge-runtime:v1.76.2'}, project, 'a' * 40)
            with patch.object(deploy, 'probe_edge', side_effect=deploy.DeployError('boot failed')), self.assertRaisesRegex(deploy.DeployError, 'previous code restored'):
                deploy.deploy_edge(runner, CONFIG, edge, directory / 'backup')
            self.assertEqual((root / 'main/index.ts').read_text(), 'old router')
            self.assertEqual((root / 'example/index.ts').read_text(), 'old worker')
            self.assertFalse((root / 'pos-release.json').exists())
            self.assertFalse((root / '_shared/helper.ts').exists())
            self.assertEqual((root / '_shared/fiscal.ts').read_text(), 'fiscal helper')
            self.assertEqual([args[1] for args in calls if args[1] in ('stop', 'start')], ['stop', 'start', 'stop', 'start'])

    def test_probe_requires_exact_sha_and_worker_marker_and_never_sends_post_or_secrets(self):
        class Response(io.BytesIO):
            def __init__(self, body, status=200, headers=None):
                super().__init__(body)
                self.status, self.headers = status, headers or {}
        class ProbeRunner:
            def command(self, *_args, **_kwargs):
                return '10.0.5.7'
        edge = {'container': 'abcdef', 'commit': 'a' * 40, 'functions': ['example']}
        for scenario in ('success', 'wrong-sha', 'missing-marker', 'boot-error'):
            calls = []
            class Opener:
                def open(self, request, **_options):
                    calls.append(request)
                    if isinstance(request, str):
                        return Response(json.dumps({'commit': ('b' if scenario == 'wrong-sha' else 'a') * 40}).encode())
                    selftest.assertEqual(request.get_method(), 'OPTIONS')
                    selftest.assertIsNone(request.data)
                    selftest.assertIsNone(request.get_header('Authorization'))
                    return Response(b'', status=503 if scenario == 'boot-error' else 405,
                                    headers={} if scenario == 'missing-marker' else {'x-pos-edge-release': 'a' * 40})
            selftest = self
            with self.subTest(scenario=scenario), patch.object(deploy.urllib.request, 'build_opener', return_value=Opener()):
                if scenario == 'success':
                    deploy.probe_edge(ProbeRunner(), CONFIG, edge)
                    self.assertEqual(len(calls), 2)
                else:
                    with self.assertRaises(deploy.DeployError):
                        deploy.probe_edge(ProbeRunner(), CONFIG, edge)


if __name__ == '__main__':
    unittest.main()
