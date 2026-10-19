#!/usr/bin/env python3
"""Root-owned SSH receiver for POS migrations on a pinned Coolify resource.

Install this file on the VPS; never execute a script supplied in the archive.
Input is a protocol-3 package; protocol-2 apply packages remain compatible.
"""

import io
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

CONFIG_FILE = Path('/etc/pos-deploy.json')
LOCK_FILE = Path('/var/lock/pos-deploy.lock')  # Same lock as the previous receiver.
MAX_PACKAGE = 64 * 1024 * 1024
MAX_SQL = 256 * 1024 * 1024
MIGRATION = re.compile(r'migrations/([0-9]{14})_[A-Za-z0-9_-]+\.sql')


class DeployError(Exception):
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
            if name.rstrip('/') == 'migrations' and member.isdir():
                continue
            match = MIGRATION.fullmatch(name)
            if not member.isfile() or (name != 'deployment.json' and not match):
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
                if match[1] in versions:
                    raise DeployError('Duplicate migration version.')
                versions.add(match[1])
                path = destination / 'supabase' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
    if not isinstance(manifest, dict) or manifest.get('protocol') not in (2, 3):
        raise DeployError('Expected a supported deployment manifest (protocol 2 or 3).')
    if manifest.get('coolify_project') != project:
        raise DeployError('Package target does not match the configured Coolify project.')
    commit = manifest.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit) or not versions:
        raise DeployError('Invalid commit or empty migration set.')
    if manifest.get('operation', 'apply') not in ('check', 'apply'):
        raise DeployError('Unsupported deployment operation.')
    if manifest.get('operation') == 'check' and manifest['protocol'] != 3:
        raise DeployError('Check mode requires protocol 3; older receivers do not support read-only checks.')
    return manifest, versions


def load_config(path):
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise DeployError('Deployment config must be root-owned and not writable by group/others.')
    config = json.loads(path.read_text())
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
        if not partial.stat().st_size:
            raise DeployError('Database backup is empty.')
        for args in (['--list'], ['--file=/dev/null']):
            with partial.open('rb') as source:
                self.command(['docker', 'exec', '-i', container, 'pg_restore', *args], stdin=source)
        partial.rename(path)


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
    if not versions or any(not re.fullmatch(r'[0-9]{14}', version) for version in versions):
        raise DeployError('Missing or invalid database migration history.')
    if len(set(versions)) != len(versions) or config['required_migration'] not in versions:
        raise DeployError('Database history does not contain the configured migration guard.')
    return set(versions)


def migrate(runner, config, project_dir, versions, backup_path, *, check_only=False):
    cli = config['supabase_bin']
    if runner.command([cli, '--version']) != config['supabase_version']:
        raise DeployError('Unexpected Supabase CLI version.')
    container, address = find_database(runner, config)
    before = ledger(runner, container, config)
    if not before <= versions:
        raise DeployError('Remote history contains migrations missing from this package; refusing downgrade.')
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
    runner.backup(container, config, backup_path)
    # dry-run also verifies TCP authentication and CLI history compatibility before any SQL is applied.
    runner.command([cli, 'db', 'push', '--db-url', url, '--include-all', '--skip-vault', '--dry-run', '--yes'],
                   cwd=project_dir, env=env)
    runner.command([cli, 'db', 'push', '--db-url', url, '--include-all', '--skip-vault', '--yes'],
                   cwd=project_dir, env=env)
    after = ledger(runner, container, config)
    if after != versions:
        raise DeployError('Post-migration history does not match the complete deployment package.')
    query(runner, container, config, "NOTIFY pgrst, 'reload schema';")
    return len(after - before)


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        raise DeployError('Run the installed receiver as root without arguments.')
    os.umask(0o077)
    os.environ['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    config = load_config(CONFIG_FILE)
    # Imported here so package-validation tests can also run on Windows.
    import fcntl
    with LOCK_FILE.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeployError('Another database deployment holds the migration lock.') from error
        for key in ('backup_dir', 'log_dir'):
            Path(config[key]).mkdir(mode=0o700, parents=True, exist_ok=True)
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
            backup_path = Path(config['backup_dir']) / f'postgres_{stamp}.dump'
            check_only = manifest.get('operation') == 'check'
            count = migrate(Runner(log), config, project, versions, backup_path, check_only=check_only)
            if check_only:
                print(f'Check complete: {count} pending migrations; no backup or migrations executed.', flush=True)
            else:
                print(f'Backup verified: {backup_path}; migrations applied: {count}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except DeployError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError):
        # Never forward tool errors, connection strings or SQL to Actions.
        print('ERROR: migration deployment stopped. Check receiver configuration and private VPS log.', file=sys.stderr)
        sys.exit(1)
