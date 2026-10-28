#!/usr/bin/env python3
"""Installed trusted packager: export data from a verified Git object, never run fetched scripts."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def export_source(mirror, commit, destination):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Invalid commit')
    process = subprocess.Popen([
        '/usr/bin/git', '--git-dir', str(mirror), 'archive', '--format=tar', commit,
        'supabase/migrations', 'supabase/functions', 'supabase/config.toml',
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    total, count, seen = 0, 0, set()
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            for member in archive:
                count += 1
                parts = member.name.rstrip('/').split('/')
                if count > 10000 or member.name in seen or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', p) or '..' in p for p in parts):
                    raise ValueError('Unsafe source archive')
                seen.add(member.name)
                if parts[0] != 'supabase' or (len(parts) > 1 and parts[1] not in ('config.toml', 'migrations', 'functions')):
                    raise ValueError('Unexpected source path')
                target = destination.joinpath(*parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    total += member.size
                    if member.size > 16 * 1024 * 1024 or total > 256 * 1024 * 1024:
                        raise ValueError('Oversized source archive')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
                else:
                    raise ValueError('Source links and special files are forbidden')
        if process.wait(timeout=30):
            raise ValueError('Git export failed')
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def package(mirror, commit, directory, config_path, output):
    os.umask(0o077)
    root = Path(directory)
    source = root / 'source'
    source.mkdir()
    export_source(mirror, commit, source)
    scripts = Path(__file__).resolve().parent
    prepared = root / 'prepared'
    prepared.mkdir()
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    subprocess.run(['/usr/bin/node', str(scripts / 'prepare-production-migrations.mjs'),
                    str(source / 'supabase/migrations'), str(prepared / 'migrations')], env=env, check=True, timeout=120)
    subprocess.run(['/usr/bin/node', str(scripts / 'prepare-edge-functions.mjs'),
                    str(source / 'supabase/functions'), str(prepared / 'functions')], env=env, check=True, timeout=120)
    config = json.loads(Path(config_path).read_text())
    (prepared / 'deployment.json').write_text(json.dumps({
        'protocol': 4, 'commit': commit, 'coolify_project': config['coolify_project'], 'operation': 'apply',
    }))
    (prepared / 'config.toml').write_bytes((source / 'supabase/config.toml').read_bytes())
    with tarfile.open(output, 'x:gz') as archive:
        for name in ('deployment.json', 'migrations', 'functions', 'config.toml'):
            archive.add(prepared / name, arcname=name)
    if Path(output).stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Oversized deployment package')


if __name__ == '__main__':
    if len(sys.argv) != 6:
        sys.exit('Usage: controller-package.py mirror SHA directory receiver-config output')
    try:
        package(*sys.argv[1:])
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError):
        sys.exit('Source packaging failed; no deployment was attempted.')
