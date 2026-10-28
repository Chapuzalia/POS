#!/usr/bin/env python3
"""Root-owned SSH receiver for POS database and Edge releases on Coolify.

Install this file on the VPS; never execute a script supplied in the archive.
Input is protocol 4; protocol-2/3 migration packages remain compatible.
"""

import io
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
from datetime import datetime, timezone

CONFIG_FILE = Path('/etc/pos-deploy.json')
LOCK_FILE = Path('/var/lock/pos-deploy.lock')  # Same lock as the previous receiver.
MAX_PACKAGE = 64 * 1024 * 1024
MAX_SQL = 256 * 1024 * 1024
MIGRATION = re.compile(r'migrations/([0-9]{14})_[A-Za-z0-9_-]+\.sql')
EDGE_SEGMENT = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*')
FUNCTION_NAME = re.compile(r'[a-z][a-z0-9-]*')
ENVIRONMENT = re.compile(r'[a-z][a-z0-9-]{0,31}')
CONFIG_ARGUMENT = re.compile(r'/etc/tickit-deploy/receiver\.([a-z][a-z0-9-]{0,31})\.json')
COOLIFY_SERVICES = Path('/data/coolify/services')
EDGE_DESTINATION = '/home/deno/functions'


def edge_package_path(name, *, directory=False):
    parts = name.rstrip('/').split('/')
    return (len(parts) >= 1 and parts[0] == 'functions'
            and all(EDGE_SEGMENT.fullmatch(part) and '..' not in part and part != 'node_modules' for part in parts)
            and (directory or (len(parts) > 1 and Path(parts[-1]).suffix in
                               ('.ts', '.tsx', '.js', '.mjs', '.json', '.lock', '.wasm')))
            and (len(parts) < 2 or parts[1] != 'pos-release.json'))


class DeployError(Exception):
    pass


class DeployCancelled(DeployError):
    pass


def unpack_package(stream, destination, project):
    data = stream.read(MAX_PACKAGE + 1)
    if not data or len(data) > MAX_PACKAGE:
        raise DeployError('Empty or oversized package.')
    seen, versions, total, manifest = set(), set(), 0, None
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = member.name
            if name in seen or len(seen) >= 10000:
                raise DeployError('Duplicate entry or too many archive entries.')
            seen.add(name)
            if member.isdir() and (name.rstrip('/') == 'migrations' or edge_package_path(name, directory=True)):
                continue
            match = MIGRATION.fullmatch(name)
            if not member.isfile() or (name not in ('deployment.json', 'config.toml') and not match and not edge_package_path(name)):
                raise DeployError('Package contains an unsupported path or entry type.')
            total += member.size
            if member.size > 16 * 1024 * 1024 or total > MAX_SQL:
                raise DeployError('Unpacked package exceeds size limit.')
            contents = archive.extractfile(member).read()
            if name == 'deployment.json':
                if member.size > 4096:
                    raise DeployError('Oversized deployment manifest.')
                manifest = json.loads(contents)
            else:
                if match and match[1] in versions:
                    raise DeployError('Duplicate migration version.')
                if match:
                    versions.add(match[1])
                path = destination / 'supabase' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
    if not isinstance(manifest, dict) or manifest.get('protocol') not in (2, 3, 4):
        raise DeployError('Expected a supported deployment manifest (protocol 2, 3 or 4).')
    if manifest.get('coolify_project') != project:
        raise DeployError('Package target does not match the configured Coolify project.')
    commit = manifest.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit) or not versions:
        raise DeployError('Invalid commit or empty migration set.')
    if manifest.get('operation', 'apply') not in ('check', 'apply'):
        raise DeployError('Unsupported deployment operation.')
    if manifest.get('operation') == 'check' and manifest['protocol'] < 3:
        raise DeployError('Check mode requires protocol 3 or later.')
    has_edge = any(name == 'config.toml' or name.startswith('functions') for name in seen)
    if has_edge != (manifest['protocol'] == 4):
        raise DeployError('Edge Functions require a complete protocol-4 package.')
    if manifest['protocol'] == 4:
        edge_release(destination / 'supabase', manifest['commit'])
    return manifest, versions


def edge_release(supabase, commit):
    """Only supported per-function settings are translated; never apply other stack settings."""
    functions = supabase / 'functions'
    if not (functions / 'main/index.ts').is_file() or not (functions / 'deno.json').is_file():
        raise DeployError('Missing Edge router or import map.')
    settings = tomllib.loads((supabase / 'config.toml').read_text(encoding='utf-8-sig')).get('functions', {})
    names = sorted(path.name for path in functions.iterdir() if path.is_dir() and path.name not in ('main', '_shared'))
    if not names or any(not FUNCTION_NAME.fullmatch(name) or not (functions / name / 'index.ts').is_file() for name in names):
        raise DeployError('Every deployed Edge Function requires a valid name and index.ts.')
    if not isinstance(settings, dict) or set(settings) - set(names):
        raise DeployError('Function configuration references missing functions.')
    translated = {}
    for name in names:
        config = settings.get(name, {})
        if not isinstance(config, dict) or set(config) - {'verify_jwt', 'import_map'}:
            raise DeployError('Unsupported per-function configuration; review the self-hosted router first.')
        verify = config.get('verify_jwt', True)
        if not isinstance(verify, bool):
            raise DeployError('verify_jwt must be a boolean.')
        import_map = config.get('import_map', './functions/deno.json')
        if not isinstance(import_map, str) or not import_map.startswith('./functions/'):
            raise DeployError('Import maps must be inside functions/.')
        relative = import_map[2:]
        if not edge_package_path(relative) or not (supabase / relative).is_file():
            raise DeployError('Missing or unsafe function import map.')
        translated[name] = {'verify_jwt': verify, 'import_map': '/home/deno/' + relative}
    return {'commit': commit, 'functions': translated}


def trusted_file(path):
    if not path.is_absolute() or not path.is_file() or path.resolve() != path:
        raise DeployError('Deployment configuration and safety tools must be plain absolute files.')
    for candidate in (path, *path.parents):
        info = candidate.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise DeployError('Deployment configuration and safety tools must be root-owned and not writable by group/others.')


def trusted_directory(path):
    if not path.is_absolute() or not path.is_dir() or path.resolve() != path:
        raise DeployError('Expected a plain absolute deployment state directory.')
    for candidate in (path, *path.parents):
        info = candidate.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise DeployError('Deployment state directories must be root-owned and not writable by group/others.')


def config_path(arguments):
    if not arguments:
        return CONFIG_FILE
    if len(arguments) == 2 and arguments[0] == '--config' and CONFIG_ARGUMENT.fullmatch(arguments[1]):
        return Path(arguments[1])
    raise DeployError('Use --config /etc/tickit-deploy/receiver.<environment>.json or no arguments.')


def load_config(path):
    trusted_file(path)
    config = json.loads(path.read_text())
    config.setdefault('environment', 'production')
    if not isinstance(config['environment'], str) or not ENVIRONMENT.fullmatch(config['environment']):
        raise DeployError('Invalid deployment environment.')
    match = CONFIG_ARGUMENT.fullmatch(str(path))
    if match and match[1] != config['environment']:
        raise DeployError('Receiver filename and configured environment must match.')
    # Only the new explicitly selected environment protocol requires the registry.
    # Preserve the installed no-argument SSH receiver's invocation compatibility.
    config['migration_history_file'] = (
        f"/var/lib/tickit-deploy/migration-history.{config['environment']}.json" if match else None)
    if config['migration_history_file']:
        trusted_directory(Path(config['migration_history_file']).parent)
    config.setdefault('node_bin', '/usr/bin/node')
    config.setdefault('migration_safety_checker', '/opt/tickit/scripts/pending-migration-safety.mjs')
    checker = Path(config['migration_safety_checker'])
    trusted_file(checker)
    trusted_file(checker.with_name('check-migrations.mjs'))
    trusted_file(Path(config['node_bin']))
    if not isinstance(config.get('migration_approvals', []), list):
        raise DeployError('Migration approvals must be an array in the installed configuration.')
    if 'backup_copy_dir' in config:
        destination = Path(config['backup_copy_dir'])
        trusted_directory(destination)
    for key in ('coolify_project', 'docker_network'):
        if not re.fullmatch(r'[a-z0-9_-]+', config.get(key, '')):
            raise DeployError('Invalid Coolify project/network configuration.')
    for key in ('db_user', 'db_name'):
        if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', config.get(key, '')):
            raise DeployError('Invalid database user/name configuration.')
    if not re.fullmatch(r'[0-9]{14}', config.get('required_migration', '')):
        raise DeployError('Configure an existing migration as the history guard.')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', config.get('supabase_version', '')):
        raise DeployError('Pin the Supabase CLI version.')
    for key in ('supabase_bin', 'backup_dir', 'log_dir'):
        if not Path(config.get(key, '')).is_absolute():
            raise DeployError('Deployment paths must be absolute.')
    return config


def phase(state):
    print(f'POS_PHASE:{state}', flush=True)


def valid_expiry(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        return False
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')) > datetime.now(timezone.utc)
    except ValueError:
        return False


def bootstrap_allowed(config):
    bootstrap = config.get('bootstrap')
    return (isinstance(bootstrap, dict) and bootstrap.get('allow_empty_ledger') is True
            and bootstrap.get('environment') == config['environment']
            and valid_expiry(bootstrap.get('expires_at')))


def migration_hashes(project_dir, versions):
    result = {}
    directory = project_dir / 'supabase/migrations'
    for version in sorted(versions):
        paths = list(directory.glob(f'{version}_*.sql'))
        if (len(paths) != 1 or paths[0].is_symlink() or not paths[0].is_file()
                or not MIGRATION.fullmatch('migrations/' + paths[0].name)):
            raise DeployError('Missing, duplicate or unsafe migration in the applied history package.')
        result[version] = hashlib.sha256(paths[0].read_bytes()).hexdigest()
    return result


def history_fingerprint(hashes):
    return hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def write_migration_history(config, hashes):
    path = Path(config['migration_history_file'])
    trusted_directory(path.parent)
    if path.exists() or path.is_symlink():
        trusted_file(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.migration-history-',
                                         dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            json.dump({'environment': config['environment'], 'hashes': hashes}, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
        if hasattr(os, 'O_DIRECTORY'):
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verify_migration_history(config, project_dir, applied, *, persist=True):
    if not config.get('migration_history_file'):
        return None
    path = Path(config['migration_history_file'])
    trusted_directory(path.parent)
    current = migration_hashes(project_dir, applied)
    if path.exists() or path.is_symlink():
        trusted_file(path)
        saved = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(saved, dict) or saved.get('environment') != config['environment']
                or saved.get('hashes') != current):
            raise DeployError('Applied migration history differs from the private content registry.')
    else:
        approval = config.get('migration_history_bootstrap')
        approved = (isinstance(approval, dict) and approval.get('environment') == config['environment']
                    and valid_expiry(approval.get('expires_at'))
                    and approval.get('sha256') == history_fingerprint(current))
        if not approved and not (not applied and bootstrap_allowed(config)):
            raise DeployError('Initialize private migration history with an exact, expiring root approval of the applied content fingerprint.')
        if persist:
            write_migration_history(config, current)
    return current


def record_applied_history(runner, container, config, project_dir, before, packaged):
    actual = ledger(runner, container, config)
    if not before <= actual or not actual <= packaged:
        raise DeployError('Database history changed unexpectedly; private migration registry requires operator review.')
    write_migration_history(config, migration_hashes(project_dir, actual))
    return actual


def telegram_approvals(config, sensitive, commit, runner):
    if not config.get('telegram'):
        raise DeployError('Sensitive migrations require confirmation; configure Telegram approval in Coolify.')
    path = Path(__file__).resolve().with_name('telegram_migration_approval.py')
    trusted_file(path)
    spec = importlib.util.spec_from_file_location('tickit_telegram_approval', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def audit(record):
        runner.log.write(json.dumps({'at': datetime.now(timezone.utc).isoformat(), 'telegram_approval': record}) + '\n')
        runner.log.flush()
        os.fsync(runner.log.fileno())

    try:
        return module.request_approvals(config['telegram'], sensitive, environment=config['environment'], commit=commit, audit=audit)
    except module.ApprovalCancelled as error:
        raise DeployCancelled(str(error)) from None
    except module.ApprovalError as error:
        raise DeployError(str(error)) from None


def run_pending_checker(runner, config, payload, *, report=False):
    with tempfile.TemporaryFile() as request:
        request.write(json.dumps(payload).encode())
        request.seek(0)
        return runner.command([config.get('node_bin', '/usr/bin/node'),
                               config.get('migration_safety_checker', '/opt/tickit/scripts/pending-migration-safety.mjs'),
                               *(['--report'] if report else [])],
                              stdin=request, env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, timeout=120)


def check_pending(runner, config, project_dir, pending, applied, *, commit=None, check_only=False):
    payload = {'directory': str((project_dir / 'supabase/migrations').resolve()),
               'pending': sorted(pending), 'applied': sorted(applied), 'commit': commit,
               'environment': config.get('environment', 'production'), 'approvals': config.get('migration_approvals', [])}
    report = json.loads(run_pending_checker(runner, config, payload, report=True))
    if (not isinstance(report, dict) or type(report.get('pending_count')) is not int or report['pending_count'] != len(pending)
            or not isinstance(report.get('sensitive'), list) or len(report['sensitive']) > len(pending)):
        raise DeployError('Invalid pending migration safety report.')
    sensitive = report['sensitive']
    if not sensitive:
        return
    if check_only:
        raise DeployError('Sensitive pending migrations require human confirmation during apply; check mode sends no messages.')
    for item in sensitive:
        name = item.get('migration', '') if isinstance(item, dict) else ''
        match = MIGRATION.fullmatch('migrations/' + name)
        if not match or match[1] not in pending:
            raise DeployError('Invalid sensitive migration identity.')
    phase('awaiting_approval')
    approved = telegram_approvals(config, sensitive, commit, runner)
    # Every decision is for the prepared bytes that were shown, not a filename
    # that can change during the wait. Do not persist approval for later jobs.
    for item in sensitive:
        contents = (project_dir / 'supabase/migrations' / item['migration']).read_bytes()
        if hashlib.sha256(contents).hexdigest() != item['sha256']:
            raise DeployError('Prepared migration changed after Telegram review; refusing deployment.')
    payload['approvals'] = [*payload['approvals'], *approved]
    run_pending_checker(runner, config, payload)


class Runner:
    def __init__(self, log):
        self.log = log
        self.secrets = []

    def command(self, args, *, env=None, cwd=None, stdin=None, stdout=None, timeout=600):
        result = subprocess.run(
            args, env=env, cwd=cwd, stdin=stdin if stdin is not None else subprocess.DEVNULL,
            stdout=stdout if stdout is not None else subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False,
        )
        output = (result.stdout or b'').decode('utf-8', errors='replace')
        diagnostic = output + result.stderr.decode('utf-8', errors='replace')
        for secret in self.secrets:
            diagnostic = diagnostic.replace(secret, '[REDACTED]')
        # Tool output/SQL remains on the VPS in a private log, never in Actions.
        self.log.write(diagnostic + '\n')
        self.log.flush()
        if result.returncode:
            raise DeployError('Remote tool failed; inspect the private deployment log on the VPS.')
        return output.strip()

    def backup(self, container, config, path):
        partial = path.with_suffix('.partial')
        with partial.open('xb') as output:
            self.command([
                'docker', 'exec', container, 'pg_dump', '-U', config['db_user'],
                '-d', config['db_name'], '--format=custom',
            ], stdout=output)
            output.flush()
            os.fsync(output.fileno())
        if not partial.stat().st_size:
            raise DeployError('Database backup is empty.')
        for args in (['--list'], ['--file=/dev/null']):
            with partial.open('rb') as source:
                self.command(['docker', 'exec', '-i', container, 'pg_restore', *args], stdin=source)
        partial.rename(path)
        if hasattr(os, 'O_DIRECTORY'):
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        if config.get('backup_copy_dir'):
            # Opt-in second filesystem/mount copy; no pruning or shell hooks.
            # Failure stops SQL while preserving the validated local backup.
            destination = Path(config['backup_copy_dir']) / path.name
            copy_partial = destination.with_suffix('.partial')
            if destination.exists():
                raise DeployError('Refusing to replace an existing external backup.')
            with path.open('rb') as source, copy_partial.open('xb') as output:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
            with path.open('rb') as source, copy_partial.open('rb') as copied:
                if hashlib.file_digest(source, 'sha256').digest() != hashlib.file_digest(copied, 'sha256').digest():
                    raise DeployError('External backup copy verification failed.')
            copy_partial.rename(destination)


def find_database(runner, config):
    containers = runner.command([
        'docker', 'ps', '--filter', f"label=com.docker.compose.project={config['coolify_project']}",
        '--filter', 'label=com.docker.compose.service=supabase-db', '--format', '{{.ID}}',
    ]).splitlines()
    if len(containers) != 1:
        raise DeployError('Expected exactly one running PostgreSQL container in the pinned Coolify project.')
    container = containers[0]
    network = json.dumps(config['docker_network'])
    address = runner.command([
        'docker', 'inspect', '--format',
        '{{with index .NetworkSettings.Networks ' + network + '}}{{.IPAddress}}{{end}}', container,
    ])
    try:
        ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError as error:
        raise DeployError('No valid PostgreSQL IPv4 address on the configured network.') from error
    return container, address


def query(runner, container, config, sql):
    return runner.command([
        'docker', 'exec', container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
        '-U', config['db_user'], '-d', config['db_name'], '-c', sql,
    ])


def ledger(runner, container, config):
    output = query(runner, container, config,
                   'BEGIN READ ONLY; COPY (SELECT version FROM supabase_migrations.schema_migrations '
                   'ORDER BY version) TO STDOUT; COMMIT;')
    # psql -q suppresses transaction command tags.
    versions = output.splitlines()
    if not versions and bootstrap_allowed(config):
        return set()
    if not versions or any(not re.fullmatch(r'[0-9]{14}', version) for version in versions):
        raise DeployError('Missing or invalid database migration history.')
    if len(set(versions)) != len(versions) or config['required_migration'] not in versions:
        raise DeployError('Database history does not contain the configured migration guard.')
    return set(versions)


def migrate(runner, config, project_dir, versions, backup_path, *, check_only=False, commit=None):
    if config['required_migration'] not in versions:
        raise DeployError('The package does not contain the configured migration guard.')
    cli = config['supabase_bin']
    if runner.command([cli, '--version']) != config['supabase_version']:
        raise DeployError('Unexpected Supabase CLI version.')
    container, address = find_database(runner, config)
    before = ledger(runner, container, config)
    if not before <= versions:
        raise DeployError('Remote history contains migrations missing from this package; refusing downgrade.')
    history = verify_migration_history(config, project_dir, before, persist=not check_only)
    pending = versions - before
    if not pending:
        return 0
    check_pending(runner, config, project_dir, pending, before, commit=commit, check_only=check_only)
    # Fetch only the current database password, without dumping Docker environment metadata.
    # Register it BEFORE logging any command result.
    result = subprocess.run(['docker', 'exec', container, 'printenv', 'POSTGRES_PASSWORD'],
                            stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=15)
    password = result.stdout.decode().rstrip('\n')
    if result.returncode or not password:
        raise DeployError('Could not read the current PostgreSQL password.')
    runner.secrets.append(password)
    env = dict(os.environ, PGPASSWORD=password, SUPABASE_DB_PASSWORD=password)
    url = f"postgresql://{config['db_user']}@{address}:5432/{config['db_name']}?sslmode=disable"
    if check_only:
        # Pass the read-only session default explicitly in the connection URI,
        # rather than relying on client-specific support for PGOPTIONS.
        readonly_url = url + '&default_transaction_read_only=on'
        runner.command([cli, 'db', 'push', '--db-url', readonly_url, '--include-all', '--skip-vault', '--dry-run', '--yes'],
                       cwd=project_dir, env=env)
        if ledger(runner, container, config) != before:
            raise DeployError('Database history changed during the deployment check.')
        return len(versions - before)
    phase('backing_up')
    runner.backup(container, config, backup_path)
    # dry-run also verifies TCP authentication and CLI history compatibility before any SQL is applied.
    runner.command([cli, 'db', 'push', '--db-url', url, '--include-all', '--skip-vault', '--dry-run', '--yes'],
                   cwd=project_dir, env=env)
    if ledger(runner, container, config) != before:
        raise DeployError('Database history changed before applying pending migrations.')
    phase('migrating')
    try:
        runner.command([cli, 'db', 'push', '--db-url', url, '--include-all', '--skip-vault', '--yes'],
                       cwd=project_dir, env=env)
    except (DeployError, OSError, subprocess.SubprocessError):
        if history is not None:
            # db push can commit some migrations before a later migration fails.
            # Preserve exactly those immutable bytes for the retry.
            record_applied_history(runner, container, config, project_dir, before, versions)
        raise
    after = (record_applied_history(runner, container, config, project_dir, before, versions)
             if history is not None else ledger(runner, container, config))
    if after != versions:
        raise DeployError('Post-migration history does not match the complete deployment package.')
    query(runner, container, config, "NOTIFY pgrst, 'reload schema';")
    return len(after - before)


def assert_plain_tree(root):
    if root.is_symlink() or not root.is_dir():
        raise DeployError('Expected a plain Edge Functions directory.')
    for path in root.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise DeployError('Edge Functions tree contains links or special files.')


def prepare_edge(runner, config, project, commit):
    """Read-only preflight: pin the resource, image, mounts and staged release before SQL."""
    if config.get('edge_image') != 'supabase/edge-runtime:v1.76.2':
        raise DeployError('Install the reviewed edge_image configuration before deploying functions.')
    containers = runner.command([
        'docker', 'ps', '--filter', f"label=com.docker.compose.project={config['coolify_project']}",
        '--filter', 'label=com.docker.compose.service=supabase-edge-functions', '--format', '{{.ID}}',
    ]).splitlines()
    if len(containers) != 1 or not re.fullmatch(r'[a-f0-9]+', containers[0]):
        raise DeployError('Expected exactly one running Edge container in the pinned Coolify project.')
    container = containers[0]
    # Do not inspect Config.Env; it contains secrets.
    metadata = json.loads(runner.command(['docker', 'inspect', '--format',
        '{"mounts":{{json .Mounts}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}}}', container]))
    root = COOLIFY_SERVICES / config['coolify_project'] / 'volumes/functions'
    if root.resolve() != root:
        raise DeployError('Edge Functions mount must not contain symlinked ancestors.')
    if metadata['image'] != config['edge_image'] or metadata['command'] != [
            'start', '--user-worker-request-idle-timeout', '150000', '--main-service', EDGE_DESTINATION + '/main']:
        raise DeployError('Edge image or startup command differs from the inspected runtime.')
    mounts = metadata['mounts']
    mounted_root = [mount for mount in mounts if mount['Destination'] == EDGE_DESTINATION]
    if len(mounted_root) != 1 or mounted_root[0]['Type'] != 'bind' or mounted_root[0]['Source'] != str(root) or not mounted_root[0]['RW']:
        raise DeployError('Unexpected Edge Functions bind mount.')
    for mount in mounts:
        destination = mount['Destination']
        if destination.startswith(EDGE_DESTINATION + '/'):
            relative = destination[len(EDGE_DESTINATION) + 1:]
            if relative not in ('main/index.ts', 'hello/index.ts') or mount['Type'] != 'bind' or mount['Source'] != str(root / relative) or not mount['RW']:
                raise DeployError('Unsupported nested Edge Functions mount.')
    assert_plain_tree(root)
    if not (root / 'main/index.ts').is_file():
        raise DeployError('Missing existing main/index.ts bind-mounted router.')
    release = edge_release(project / 'supabase', commit)
    if 'hello' in release['functions']:
        raise DeployError('hello is reserved by the inspected Coolify bind mount.')
    # Keep VPS-only functions, including fiscal endpoints, and their existing auth behavior.
    old = root / 'pos-release.json'
    previous = json.loads(old.read_text()) if old.is_file() else {'functions': {}}
    global_verify = runner.command(['docker', 'exec', container, 'printenv', 'VERIFY_JWT'])
    if global_verify not in ('true', 'false'):
        raise DeployError('Expected an explicit VERIFY_JWT setting in the existing runtime.')
    for path in root.iterdir():
        if path.is_dir() and FUNCTION_NAME.fullmatch(path.name) and path.name != 'main' and (path / 'index.ts').is_file():
            release['functions'].setdefault(path.name, previous['functions'].get(path.name,
                {'verify_jwt': global_verify == 'true', 'import_map': None}))
    source = project / 'supabase/functions'
    staged = project / 'edge-staged'
    shutil.copytree(source, staged)
    # Merge shared helpers so VPS-only fiscal functions keep their dependencies.
    if (root / '_shared').is_dir() and (source / '_shared').is_dir():
        shutil.rmtree(staged / '_shared')
        shutil.copytree(root / '_shared', staged / '_shared')
        shutil.copytree(source / '_shared', staged / '_shared', dirs_exist_ok=True)
    (staged / 'pos-release.json').write_text(json.dumps(release))
    return {'container': container, 'root': root, 'staged': staged, 'commit': commit,
            'functions': sorted(edge_release(project / 'supabase', commit)['functions'])}


def copy_edge_entry(source, destination):
    # main/index.ts has its own file bind mount. Preserve its inode (and the root
    # mount inode); renaming a new directory over either mount would serve stale code.
    if source.name == 'main':
        (destination / 'index.ts').write_bytes((source / 'index.ts').read_bytes())
    else:
        if destination.is_dir():
            shutil.rmtree(destination)
        elif destination.exists():
            destination.unlink()
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copyfile(source, destination)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_edge(runner, config, edge):
    network = json.dumps(config['docker_network'])
    address = runner.command(['docker', 'inspect', '--format',
        '{{with index .NetworkSettings.Networks ' + network + '}}{{.IPAddress}}{{end}}', edge['container']])
    try:
        ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError as error:
        raise DeployError('Edge runtime has no IPv4 address on the pinned network.') from error
    # No gateway/API keys, redirects, environment proxies, request bodies or POSTs.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = f'http://{address}:9000'
    for attempt in range(30):
        try:
            with opener.open(base + '/_pos_health', timeout=3) as response:
                if response.status != 200 or json.loads(response.read(4096)).get('commit') != edge['commit']:
                    raise DeployError('Edge health does not match the release SHA.')
            break
        except (OSError, ValueError):
            if attempt == 29:
                raise DeployError('Edge runtime did not become ready.') from None
            time.sleep(1)
    for name in edge['functions']:
        request = urllib.request.Request(base + '/' + name, method='OPTIONS')
        try:
            response = opener.open(request, timeout=70)
        except urllib.error.HTTPError as error:
            response = error
        except OSError:
            raise DeployError('Edge function smoke check could not connect.') from None
        with response:
            if response.status >= 500 or response.headers.get('x-pos-edge-release') != edge['commit']:
                raise DeployError('Edge function failed its OPTIONS boot check; frontend deployment stopped.')


def deploy_edge(runner, config, edge, backup_path):
    root, staged, container = edge['root'], edge['staged'], edge['container']
    # Durable private code snapshot; independent of the database backup.
    shutil.copytree(root, backup_path)
    backup_path.chmod(0o700)
    names = sorted(path.name for path in staged.iterdir())
    try:
        runner.command(['docker', 'stop', '--time', '75', container], timeout=90)
        for name in names:
            copy_edge_entry(staged / name, root / name)
        runner.command(['docker', 'start', container], timeout=90)
        probe_edge(runner, config, edge)
    except (DeployError, OSError, ValueError, subprocess.SubprocessError):
        try:
            runner.command(['docker', 'stop', '--time', '75', container], timeout=90)
            for name in names:
                if (backup_path / name).exists():
                    copy_edge_entry(backup_path / name, root / name)
                elif (root / name).is_dir():
                    shutil.rmtree(root / name)
                elif (root / name).exists():
                    (root / name).unlink()
            runner.command(['docker', 'start', container], timeout=90)
        except (DeployError, OSError, subprocess.SubprocessError):
            raise DeployError('Edge deployment and code recovery failed; inspect the private VPS backup immediately.') from None
        raise DeployError('Edge verification failed; previous code restored and restart requested. SQL remains applied; frontend stopped.') from None


def main():
    selected_config = config_path(sys.argv[1:])
    if os.geteuid() != 0:
        raise DeployError('Run the installed receiver as root.')
    os.umask(0o077)
    os.environ['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    config = load_config(selected_config)
    # Imported here so package-validation tests can also run on Windows.
    import fcntl
    with LOCK_FILE.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeployError('Another database deployment holds the migration lock.') from error
        for key in ('backup_dir', 'log_dir'):
            Path(config[key]).mkdir(mode=0o700, parents=True, exist_ok=True)
            trusted_directory(Path(config[key]))
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ')
        log_path = Path(config['log_dir']) / f'deploy_{stamp}.log'
        with log_path.open('x') as log, tempfile.TemporaryDirectory(prefix='pos-deploy-') as directory:
            project = Path(directory)
            # Do not let an idle SSH sender hold the deployment lock indefinitely.
            signal.signal(signal.SIGALRM, lambda *_: sys.exit('Package receive timeout.'))
            signal.alarm(120)
            manifest, versions = unpack_package(sys.stdin.buffer, project, config['coolify_project'])
            signal.alarm(0)
            print(f"Coolify project: {config['coolify_project']}; commit: {manifest['commit']}", flush=True)
            print(f'Private VPS log: {log_path}', flush=True)
            prefix = config['environment'] + '_' if config.get('migration_history_file') else ''
            backup_path = Path(config['backup_dir']) / f'postgres_{prefix}{stamp}.dump'
            check_only = manifest.get('operation') == 'check'
            runner = Runner(log)
            if config.get('telegram', {}).get('bot_token'):
                runner.secrets.append(config['telegram']['bot_token'])
            phase('preflight')
            edge = prepare_edge(runner, config, project, manifest['commit']) if manifest['protocol'] == 4 else None
            count = migrate(runner, config, project, versions, backup_path, check_only=check_only, commit=manifest['commit'])
            if edge and not check_only:
                phase('deploying_edge')
                edge_backup = Path(config['backup_dir']) / f'functions_{prefix}{stamp}'
                deploy_edge(runner, config, edge, edge_backup)
                print(f"Edge release verified: {manifest['commit']}; code backup: {edge_backup}", flush=True)
            if check_only:
                print(f'Check complete: {count} pending migrations; no backup, SQL or Edge runtime changes executed.', flush=True)
            else:
                if count:
                    print(f'Backup verified: {backup_path}; migrations applied: {count}', flush=True)
                else:
                    print('No pending migrations; database backup and push skipped.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except DeployCancelled as error:
        print(f'CANCELLED: {error}', file=sys.stderr)
        sys.exit(3)
    except DeployError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError):
        # Never forward tool errors, connection strings or SQL to Actions.
        print('ERROR: migration deployment stopped. Check receiver configuration and private VPS log.', file=sys.stderr)
        sys.exit(1)
