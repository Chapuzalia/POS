"""Real local Git archives, no remote services or databases."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller_package', Path(__file__).parents[1] / 'scripts/controller-package.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '--quiet')
        for name, content in {'supabase/migrations/20260101000000_first.sql': 'SELECT 1;',
                              'supabase/functions/example/index.ts': 'Deno.serve(() => new Response("ok"));',
                              'supabase/config.toml': '[functions.example]\nverify_jwt = false',
                              'scripts/arbitrary.sh': 'NEVER EXECUTE'}.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.destination = self.root / 'source'
        self.destination.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args, input=None):
        return subprocess.run(['git', '-C', str(self.repo), *args], input=input, text=True, capture_output=True, check=True).stdout

    def export(self):
        original = subprocess.Popen

        def local_git(args, **kwargs):
            # Only replace the Linux executable path at the OS process boundary.
            self.assertEqual(args[0], '/usr/bin/git')
            return original([shutil.which('git'), *args[1:]], **kwargs)

        with patch.object(packager.subprocess, 'Popen', side_effect=local_git):
            packager.export_source(self.repo / '.git', self.commit, self.destination)

    def test_exact_commit_exports_only_supabase_data(self):
        (self.repo / 'supabase/config.toml').write_text('UNCOMMITTED CONTENT')
        self.export()
        self.assertEqual((self.destination / 'supabase/config.toml').read_text(), '[functions.example]\nverify_jwt = false')
        self.assertFalse((self.destination / 'scripts').exists())

    def test_source_symlink_is_rejected_without_following_it(self):
        blob = self.git('hash-object', '-w', '--stdin', input='/etc/shadow\n').strip()
        self.git('update-index', '--add', '--cacheinfo', f'120000,{blob},supabase/functions/example/unsafe.ts')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'unsafe fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        with self.assertRaisesRegex(ValueError, 'links and special'):
            self.export()
        self.assertFalse((self.destination / 'supabase/functions/example/unsafe.ts').exists())

    def test_invalid_sha_never_starts_a_command(self):
        with patch.object(packager.subprocess, 'Popen') as command:
            with self.assertRaisesRegex(ValueError, 'Invalid commit'):
                packager.export_source(self.repo / '.git', '--upload-pack=evil', self.destination)
            command.assert_not_called()

    def test_cli_accepts_documented_five_arguments(self):
        work = self.root / 'work'
        work.mkdir()
        result = subprocess.run([sys.executable, '-B', packager.__file__, str(self.root / 'missing.git'),
                                 self.commit, str(work), 'missing-config', str(work / 'package.tar.gz')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Source packaging failed', result.stderr)
        self.assertNotIn('Usage:', result.stderr)


if __name__ == '__main__':
    unittest.main()
