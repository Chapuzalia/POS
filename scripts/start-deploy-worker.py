#!/usr/bin/env python3
"""Container entrypoint. Coolify supplies private configuration; no host installer."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

CONFIG_DIR = Path('/etc/tickit-deploy')
DATA_DIR = Path('/var/lib/tickit-deploy')
IPC_DIR = Path('/run/tickit-deploy')
FIXED_RECEIVER = {
    'supabase_bin': '/usr/bin/supabase', 'supabase_version': '2.121.0',
    'node_bin': '/usr/bin/node', 'migration_safety_checker': '/opt/tickit/scripts/pending-migration-safety.mjs',
    'backup_dir': '/opt/pos-deploy/backups', 'log_dir': '/var/log/pos-deploy',
}


def configuration_files(value):
    if not isinstance(value, str) or not value or len(value) > 262144:
        raise ValueError('Set DEPLOY_CONTROLLER_CONFIG in Coolify (maximum 256 KiB).')
    try:
        config = json.loads(value)
    except ValueError:
        raise ValueError('DEPLOY_CONTROLLER_CONFIG must contain valid JSON.') from None
    if not isinstance(config, dict) or not isinstance(config.get('environments'), dict):
        raise ValueError('Configure environments in DEPLOY_CONTROLLER_CONFIG.')
    config.setdefault('audience', 'https://deploy.alteilsolutions.com')
    files = {}
    for environment in ('production', 'staging'):
        policy = config['environments'].get(environment)
        if not isinstance(policy, dict) or type(policy.get('enabled')) is not bool:
            raise ValueError('Configure enabled for both environments.')
        receiver = policy.pop('receiver', None)
        if not policy['enabled']:
            continue
        if not isinstance(receiver, dict):
            raise ValueError('Each enabled environment needs receiver configuration.')
        for key, fixed in {**FIXED_RECEIVER, 'environment': environment}.items():
            if key in receiver and receiver[key] != fixed:
                raise ValueError('Receiver executable and runtime paths are fixed in the image.')
            receiver[key] = fixed
        receiver.setdefault('db_user', 'supabase_admin')
        receiver.setdefault('db_name', 'postgres')
        receiver.setdefault('edge_image', 'supabase/edge-runtime:v1.76.2')
        receiver.setdefault('migration_approvals', [])
        files[f'receiver.{environment}.json'] = json.dumps(receiver)
    files['controller.json'] = json.dumps(config)
    return files


def write_private_files(directory, files):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('Configuration directory must be a plain directory.')
    directory.chmod(0o700)
    for name, value in files.items():
        path = directory / name
        if path.is_symlink():
            raise ValueError('Configuration files must not be symlinks.')
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            os.chmod(path, 0o600)
            output.write(value)


def main():
    if os.geteuid() != 0:
        raise ValueError('Only the internal worker container runs this entrypoint.')
    os.umask(0o077)
    files = configuration_files(os.environ.get('DEPLOY_CONTROLLER_CONFIG'))
    key = os.environ.get('DEPLOY_REPOSITORY_KEY', '')
    known_hosts = os.environ.get('DEPLOY_GITHUB_KNOWN_HOSTS', '')
    if not key.startswith('-----BEGIN OPENSSH PRIVATE KEY-----') or len(key) > 32768 or not known_hosts or len(known_hosts) > 32768:
        raise ValueError('Configure DEPLOY_REPOSITORY_KEY and DEPLOY_GITHUB_KNOWN_HOSTS in Coolify.')
    files['repository_ed25519'] = key.replace('\r\n', '\n').rstrip() + '\n'
    files['github_known_hosts'] = known_hosts.replace('\r\n', '\n').rstrip() + '\n'
    write_private_files(CONFIG_DIR, files)
    DATA_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    DATA_DIR.chmod(0o700)
    IPC_DIR.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(IPC_DIR, 0, 2010)
    IPC_DIR.chmod(0o750)
    # These bind mounts preserve the old receiver lock and existing backups.
    for name in ('tickit-controller.lock', 'pos-deploy.lock'):
        path = Path('/var/lock') / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Shared deployment lock must be a private root-owned file.')
        finally:
            os.close(descriptor)
    import fcntl
    lock = os.open('/var/lock/tickit-controller.lock', os.O_WRONLY | os.O_NOFOLLOW)
    # Acquire before touching the shared mirror, configuration consumers or queue.
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(lock, True)
    environment = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
    mirror = DATA_DIR / 'repository.git'
    if not mirror.exists():
        subprocess.run(['/usr/bin/git', 'init', '--bare', str(mirror)], env=environment, check=True, capture_output=True)
        subprocess.run(['/usr/bin/git', '--git-dir', str(mirror), 'remote', 'add', 'origin', 'git@github.com:Chapuzalia/POS.git'], env=environment, check=True, capture_output=True)
    # Never propagate Coolify secrets through subprocess environments or logs.
    os.execve('/usr/bin/node', ['/usr/bin/node', '/opt/tickit/apps/deploy-controller/src/worker.ts'], environment)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        if isinstance(error, ValueError):
            sys.exit(str(error))
        sys.exit('Worker container could not initialize; check Coolify mounts, configuration and deployment locks.')
