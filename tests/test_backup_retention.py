import importlib.util
from pathlib import Path
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'scripts/deploy-backup-retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class RetentionTests(unittest.TestCase):
    def test_retention_is_disabled_by_default_and_never_selects_legacy_or_other_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('postgres_20250101T000000_000000Z.dump', 'postgres_production_20250101T000000_000000Z.dump',
                         'postgres_staging_20250101T000000_000000Z.dump', 'postgres_staging_20250102T000000_000000Z.dump',
                         'postgres_staging_20250103T000000_000000Z.dump'):
                (root / name).write_bytes(b'verified fixture')
            self.assertEqual(retention.retention_plan(root, 'staging', None, 2), [])
            plan = retention.retention_plan(root, 'staging', 30, 2, now=time.time() + 86400 * 100)
            self.assertEqual([p.name for p in plan], ['postgres_staging_20250101T000000_000000Z.dump'])
            self.assertEqual(len(list(root.iterdir())), 5)

    def test_preserves_recent_backups_and_minimum_recovery_points(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for day in range(1, 5):
                (root / f'postgres_staging_2025010{day}T000000_000000Z.dump').write_bytes(b'dump')
            self.assertEqual(retention.retention_plan(root, 'staging', 30, 2, now=time.time()), [])
            with self.assertRaises(ValueError):
                retention.retention_plan(root, 'staging', 30, 0)


if __name__ == '__main__':
    unittest.main()
