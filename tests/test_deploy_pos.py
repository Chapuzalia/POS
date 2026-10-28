import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from contextlib import redirect_stdout
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
    'environment': 'production', 'node_bin': 'node',
    'migration_safety_checker': str(Path(__file__).parents[1] / 'scripts/pending-migration-safety.mjs'),
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
        if args[1:2] == [CONFIG['migration_safety_checker']]:
            result = subprocess.run(args, stdin=options['stdin'], capture_output=True, check=False)
            if result.returncode:
                raise deploy.DeployError('Unsafe pending migration')
            return result.stdout.decode().strip()
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
        original_run = subprocess.run
        def run(args, **options):
            return credential if 'printenv' in args else original_run(args, **options)
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy.subprocess, 'run', side_effect=run):
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            for version in (VERSION, NEW_VERSION):
                (migrations / f'{version}_example.sql').write_text(
                    "-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\nselect 1;", encoding='utf-8')
            return deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump'), check_only=check_only)

    def test_zero_pending_skips_backup_password_and_all_pushes(self):
        runner = FakeRunner(before=[VERSION, NEW_VERSION])
        with patch.object(deploy.subprocess, 'run') as external:
            self.assertEqual(deploy.migrate(runner, CONFIG, Path('/project'), {VERSION, NEW_VERSION}, Path('/backup.dump')), 0)
        external.assert_not_called()
        self.assertFalse(any('push' in args or args == ['backup'] for args, _ in runner.calls))

    def test_pending_safety_failure_stops_before_backup_and_password(self):
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            (migrations / f'{NEW_VERSION}_unsafe.sql').write_text('drop table public.sales;')
            with self.assertRaises(deploy.DeployError), patch.object(deploy.subprocess, 'run', wraps=subprocess.run) as external:
                deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump'))
            self.assertFalse(any('printenv' in call.args[0] for call in external.call_args_list))
        self.assertNotIn(['backup'], [args for args, _ in runner.calls])

    def test_sensitive_sql_is_not_applied_until_telegram_approves_exact_content(self):
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            name = f'{NEW_VERSION}_sensitive.sql'
            sql = "-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\ndrop table public.example;"
            (migrations / name).write_text(sql, encoding='utf-8')
            def approve(config, sensitive, commit, audit_runner):
                self.assertFalse(runner.applied)
                self.assertNotIn(['backup'], [args for args, _ in runner.calls])
                self.assertEqual(sensitive[0]['migration'], name)
                self.assertIn('DROP', sensitive[0]['reasons'])
                return [{'environment': 'production', 'migration': name, 'sha256': hashlib.sha256((migrations / name).read_bytes()).hexdigest(),
                         'commit': commit, 'expires_at': '2099-01-01T00:00:00Z', 'reason': 'Telegram approval'}]
            original_run = subprocess.run
            def run(args, **options):
                return subprocess.CompletedProcess([], 0, b'password\n', b'') if 'printenv' in args else original_run(args, **options)
            with patch.object(deploy, 'telegram_approvals', side_effect=approve), patch.object(deploy.subprocess, 'run', side_effect=run):
                self.assertEqual(deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump'), commit='a' * 40), 1)
            self.assertTrue(runner.applied)
            self.assertIn(['backup'], [args for args, _ in runner.calls])

    def test_telegram_cancellation_stops_before_password_backup_and_push(self):
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            (migrations / f'{NEW_VERSION}_sensitive.sql').write_text('drop table public.example;', encoding='utf-8')
            with patch.object(deploy, 'telegram_approvals', side_effect=deploy.DeployCancelled('cancelled')), \
                    patch.object(deploy.subprocess, 'run', wraps=subprocess.run) as external, self.assertRaises(deploy.DeployCancelled):
                deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump'), commit='a' * 40)
            self.assertFalse(any('printenv' in call.args[0] for call in external.call_args_list))
            self.assertFalse(runner.applied)
            self.assertNotIn(['backup'], [args for args, _ in runner.calls])

    def test_changed_sql_after_human_approval_is_rejected(self):
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            path = migrations / f'{NEW_VERSION}_sensitive.sql'
            path.write_text('drop table public.example;', encoding='utf-8')
            def changed(config, sensitive, commit, audit_runner):
                path.write_text('drop table public.sales;', encoding='utf-8')
                return [{'environment': 'production', 'migration': sensitive[0]['migration'], 'sha256': sensitive[0]['sha256'],
                         'commit': commit, 'expires_at': '2099-01-01T00:00:00Z', 'reason': 'Telegram approval'}]
            with patch.object(deploy, 'telegram_approvals', side_effect=changed), self.assertRaises(deploy.DeployError):
                deploy.check_pending(runner, CONFIG, project, {NEW_VERSION}, {VERSION}, commit='a' * 40)

    def test_readonly_check_never_sends_telegram_messages(self):
        runner = FakeRunner()
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            (migrations / f'{NEW_VERSION}_sensitive.sql').write_text('drop table public.example;', encoding='utf-8')
            with patch.object(deploy, 'telegram_approvals') as approve, self.assertRaises(deploy.DeployError):
                deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump'), check_only=True)
            approve.assert_not_called()

    def test_only_sql_missing_from_ledger_is_safety_checked(self):
        runner = FakeRunner()
        credential = subprocess.CompletedProcess([], 0, b'password\n', b'')
        original_run = subprocess.run
        def run(args, **options):
            return credential if 'printenv' in args else original_run(args, **options)
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy.subprocess, 'run', side_effect=run):
            project = Path(directory)
            migrations = project / 'supabase/migrations'
            migrations.mkdir(parents=True)
            (migrations / f'{VERSION}_historical.sql').write_text('drop table public.historical;')
            (migrations / f'{NEW_VERSION}_new.sql').write_text(
                "-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\nselect 1;")
            self.assertEqual(deploy.migrate(runner, CONFIG, project, {VERSION, NEW_VERSION}, Path('/backup.dump')), 1)

    def test_empty_ledger_requires_expiring_environment_bound_bootstrap_config(self):
        runner = FakeRunner(before=[])
        with self.assertRaises(deploy.DeployError):
            deploy.ledger(runner, 'db', CONFIG)
        approved = {**CONFIG, 'bootstrap': {'allow_empty_ledger': True, 'environment': 'production',
                                          'expires_at': '2099-01-01T00:00:00Z'}}
        self.assertEqual(deploy.ledger(runner, 'db', approved), set())
        for change in ({'environment': 'staging'}, {'expires_at': '2000-01-01T00:00:00Z'}, {'allow_empty_ledger': 'true'}):
            with self.subTest(change=change), self.assertRaises(deploy.DeployError):
                deploy.ledger(runner, 'db', {**approved, 'bootstrap': {**approved['bootstrap'], **change}})

    def test_config_argument_only_allows_installed_environment_paths(self):
        self.assertEqual(deploy.config_path([]), deploy.CONFIG_FILE)
        self.assertEqual(deploy.config_path(['--config', '/etc/tickit-deploy/receiver.production.json']).as_posix(),
                         '/etc/tickit-deploy/receiver.production.json')
        for args in (['--config', '/tmp/custom.json'], ['--config', '/etc/tickit-deploy/receiver...json'],
                     ['--config', '/etc/tickit-deploy/receiver.production.json', 'extra'], ['--help']):
            with self.subTest(args=args), self.assertRaises(deploy.DeployError):
                deploy.config_path(args)

    def test_pending_phases_are_structured_and_ordered(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.run_migration(FakeRunner())
        self.assertEqual(output.getvalue().splitlines(), ['POS_PHASE:backing_up', 'POS_PHASE:migrating'])

    def test_main_still_deploys_edge_when_database_has_no_pending_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {**CONFIG, 'backup_dir': str(root / 'backups'), 'log_dir': str(root / 'logs'),
                      'migration_history_file': str(root / 'migration-history.production.json')}
            manifest = {'protocol': 4, 'commit': 'a' * 40}
            output = io.StringIO()
            fcntl = SimpleNamespace(flock=lambda *_: None, LOCK_EX=2, LOCK_NB=4)
            def prepare(*_args):
                self.assertIn('POS_PHASE:preflight', output.getvalue())
                return {'prepared': True}
            with patch.dict(deploy.sys.modules, {'fcntl': fcntl}), patch.dict(deploy.os.environ), \
                    patch.object(deploy.os, 'geteuid', return_value=0, create=True), \
                    patch.object(deploy.os, 'umask'), patch.object(deploy.sys, 'argv', ['receiver']), \
                    patch.object(deploy.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO())), \
                    patch.object(deploy, 'load_config', return_value=config), \
                    patch.object(deploy, 'trusted_directory'), \
                    patch.object(deploy, 'LOCK_FILE', root / 'deploy.lock'), \
                    patch.object(deploy.signal, 'SIGALRM', 14, create=True), \
                    patch.object(deploy.signal, 'signal'), patch.object(deploy.signal, 'alarm', create=True), \
                    patch.object(deploy, 'unpack_package', return_value=(manifest, {VERSION})), \
                    patch.object(deploy, 'prepare_edge', side_effect=prepare), \
                    patch.object(deploy, 'migrate', return_value=0) as migrations, \
                    patch.object(deploy, 'deploy_edge') as edge, redirect_stdout(output):
                deploy.main()
            edge.assert_called_once()
            self.assertTrue(edge.call_args.args[-1].name.startswith('functions_production_'))
            self.assertTrue(migrations.call_args.args[-1].name.startswith('postgres_production_'))
            self.assertIn('POS_PHASE:deploying_edge', output.getvalue())
            self.assertNotIn('Backup verified:', output.getvalue())

    def test_external_ledger_change_during_dry_run_stops_sql_apply(self):
        runner = FakeRunner()
        command = runner.command
        def mutate_history(args, **options):
            result = command(args, **options)
            if 'push' in args and '--dry-run' in args:
                runner.before = [VERSION, NEW_VERSION]
            return result
        runner.command = mutate_history
        with self.assertRaises(deploy.DeployError):
            self.run_migration(runner)
        self.assertFalse(runner.applied)

    def test_backup_optional_second_copy_is_verified_without_removing_existing_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / 'external'
            external.mkdir()
            old = external / 'older.dump'
            old.write_bytes(b'keep')
            path = root / 'postgres.dump'
            runner = deploy.Runner(io.StringIO())
            def command(args, **options):
                if 'pg_dump' in args:
                    options['stdout'].write(b'valid-archive-content')
            runner.command = command
            runner.backup('db', {**CONFIG, 'backup_copy_dir': str(external)}, path)
            self.assertEqual((external / path.name).read_bytes(), b'valid-archive-content')
            self.assertEqual(old.read_bytes(), b'keep')

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


class HistoryRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.project = self.root / 'project'
        self.migrations = self.project / 'supabase/migrations'
        self.migrations.mkdir(parents=True)
        self.sql = b"-- migration-safety: expand\nset lock_timeout = '5s';\nset statement_timeout = '5min';\nselect 1;"
        self.third = '20261020120000'
        for version in (VERSION, NEW_VERSION, self.third):
            (self.migrations / f'{version}_example.sql').write_bytes(self.sql)
        self.registry = self.root / 'state' / 'history.production.json'
        self.registry.parent.mkdir()
        self.config = {**CONFIG, 'migration_history_file': str(self.registry)}
        self.permissions = patch.object(deploy, 'trusted_directory')
        self.files = patch.object(deploy, 'trusted_file')
        self.permissions.start()
        self.files.start()

    def tearDown(self):
        self.permissions.stop()
        self.files.stop()
        self.temporary.cleanup()

    def approve(self, versions):
        hashes = {version: hashlib.sha256(self.sql).hexdigest() for version in versions}
        digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.config['migration_history_bootstrap'] = {
            'environment': 'production', 'expires_at': '2099-01-01T00:00:00Z', 'sha256': digest,
        }

    def migrate(self, runner, *, check_only=False):
        original = subprocess.run
        def run(args, **options):
            if 'printenv' in args:
                return subprocess.CompletedProcess([], 0, b'password\n', b'')
            return original(args, **options)
        with patch.object(deploy.subprocess, 'run', side_effect=run):
            return deploy.migrate(runner, self.config, self.project,
                                  {VERSION, NEW_VERSION, self.third}, self.root / 'backup.dump', check_only=check_only)

    def test_first_registry_requires_environment_expiry_and_exact_applied_content_approval(self):
        with self.assertRaises(deploy.DeployError):
            deploy.verify_migration_history(self.config, self.project, {VERSION})
        self.approve({VERSION})
        approved = dict(self.config['migration_history_bootstrap'])
        for change in ({'environment': 'staging'}, {'expires_at': '2000-01-01T00:00:00Z'}, {'sha256': 'a' * 64}):
            self.config['migration_history_bootstrap'] = {**approved, **change}
            with self.subTest(change=change), self.assertRaises(deploy.DeployError):
                deploy.verify_migration_history(self.config, self.project, {VERSION})
            self.assertFalse(self.registry.exists())
        self.config['migration_history_bootstrap'] = approved
        fingerprint = subprocess.run([CONFIG['node_bin'], CONFIG['migration_safety_checker'], '--history-hash'],
                                     input=json.dumps({'directory': str(self.migrations), 'applied': [VERSION]}).encode(),
                                     capture_output=True, check=True)
        self.assertEqual(json.loads(fingerprint.stdout)['sha256'], approved['sha256'])
        deploy.verify_migration_history(self.config, self.project, {VERSION})
        saved = json.loads(self.registry.read_text())
        self.assertEqual(saved['environment'], 'production')
        self.assertEqual(saved['hashes'], {VERSION: hashlib.sha256(self.sql).hexdigest()})

    def test_changed_applied_sql_and_removed_applied_versions_stop_before_backup(self):
        self.approve({VERSION})
        deploy.verify_migration_history(self.config, self.project, {VERSION})
        historical = self.migrations / f'{VERSION}_example.sql'
        historical.write_bytes(self.sql + b'\n-- edited historical content')
        runner = FakeRunner()
        with self.assertRaises(deploy.DeployError):
            self.migrate(runner)
        self.assertNotIn(['backup'], [args for args, _ in runner.calls])
        historical.write_bytes(self.sql)
        with self.assertRaises(deploy.DeployError):
            deploy.verify_migration_history(self.config, self.project, set())

    def test_check_only_does_not_seed_local_registry(self):
        self.approve({VERSION})
        self.assertEqual(self.migrate(FakeRunner(), check_only=True), 2)
        self.assertFalse(self.registry.exists())

    def test_partial_apply_records_only_actual_ledger_and_retry_checks_remaining_sql(self):
        self.approve({VERSION})
        runner = FakeRunner(after=[VERSION, NEW_VERSION])
        command = runner.command
        def partial(args, **options):
            result = command(args, **options)
            if 'push' in args and '--dry-run' not in args:
                raise deploy.DeployError('Interrupted after first pending migration')
            return result
        runner.command = partial
        with self.assertRaises(deploy.DeployError):
            self.migrate(runner)
        saved = json.loads(self.registry.read_text())
        self.assertEqual(set(saved['hashes']), {VERSION, NEW_VERSION})
        retry = FakeRunner(before=[VERSION, NEW_VERSION], after=[VERSION, NEW_VERSION, self.third])
        self.assertEqual(self.migrate(retry), 1)
        self.assertEqual(set(json.loads(self.registry.read_text())['hashes']), {VERSION, NEW_VERSION, self.third})


class TrustBoundaryTests(unittest.TestCase):
    def test_nonroot_file_or_writable_ancestor_cannot_authorize_sql_or_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / 'root-policy.json'
            file.write_text('{}')
            original = Path.stat
            bad = None
            def metadata(path, *args, **options):
                values = list(original(path, *args, **options))
                values[0] &= ~0o022
                values[4] = 0
                if bad == 'owner' and path == file:
                    values[4] = 1000
                if bad == 'ancestor' and path == root:
                    values[0] |= 0o020
                return deploy.os.stat_result(values)
            with patch.object(Path, 'stat', metadata):
                deploy.trusted_file(file)
                deploy.trusted_directory(root)
                bad = 'owner'
                with self.assertRaises(deploy.DeployError):
                    deploy.trusted_file(file)
                bad = 'ancestor'
                with self.assertRaises(deploy.DeployError):
                    deploy.trusted_file(file)
                with self.assertRaises(deploy.DeployError):
                    deploy.trusted_directory(root)


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
