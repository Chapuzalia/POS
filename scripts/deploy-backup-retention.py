#!/usr/bin/env python3
"""Offline backup retention. Disabled by default; prints a plan unless --apply is explicit.

Only environment-prefixed controller backups are eligible. Legacy backups are
never selected. Never install this as an automatic migration/cutover operation.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time


def retention_plan(directory, environment, days, minimum=7, *, now=None):
    if days is None:
        return []
    if (type(days) is not int or days < 1 or type(minimum) is not int or minimum < 2
            or environment not in ('production', 'staging')):
        raise ValueError('Retention requires positive days and at least two recovery points.')
    root = Path(directory)
    threshold = (time.time() if now is None else now) - days * 86400
    result = []
    for kind in ('postgres', 'functions'):
        suffix = r'\.dump' if kind == 'postgres' else ''
        pattern = re.compile(kind + '_' + environment + r'_\d{8}T\d{6}_\d{6}Z' + suffix)
        candidates = sorted((path for path in root.iterdir() if pattern.fullmatch(path.name)), key=lambda path: path.name, reverse=True)
        for path in candidates:
            if path.is_symlink() or (kind == 'postgres' and not path.is_file()) or (kind == 'functions' and not path.is_dir()):
                raise ValueError('Refusing non-plain backup paths.')
        result.extend(path for path in candidates[minimum:] if path.stat().st_mtime < threshold)
    return result


def main(arguments):
    apply = arguments[-1:] == ['--apply']
    if apply:
        arguments = arguments[:-1]
    if len(arguments) != 2 or arguments[0] != '--config' or not re.fullmatch(r'/etc/tickit-deploy/receiver\.(production|staging)\.json', arguments[1]):
        raise ValueError('Usage: deploy-backup-retention.py --config /etc/tickit-deploy/receiver.<environment>.json [--apply]')
    if os.geteuid() != 0:
        raise ValueError('Run the installed offline tool as root.')
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('receiver', Path(__file__).resolve().with_name('deploy-pos.py'))
    receiver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(receiver)
    config = receiver.load_config(Path(arguments[1]))
    root = Path(config['backup_dir'])
    receiver.trusted_directory(root)
    import fcntl
    with Path('/var/lock/tickit-controller.lock').open('a') as controller, receiver.LOCK_FILE.open('a') as lock:
        fcntl.flock(controller, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = retention_plan(root, config['environment'], config.get('backup_retention_days'), config.get('backup_retention_minimum', 7))
        # Validate the full plan before any deletion; all targets must be direct
        # descendants of this exact root, with no symlinks or special files.
        for path in selected:
            if path.resolve().parent != root.resolve():
                raise ValueError('Backup path escaped its configured root.')
            if path.is_dir():
                receiver.assert_plain_tree(path)
            else:
                receiver.trusted_file(path)
        print(json.dumps({'apply': apply, 'environment': config['environment'], 'paths': [str(path) for path in selected]}))
        if apply:
            for path in selected:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError):
        sys.exit('Retention stopped; inspect private configuration, locks and paths. No automatic retry is performed.')
