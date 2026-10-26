import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('worker_start', Path(__file__).parents[1] / 'scripts/start-deploy-worker.py')
worker_start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_start)


def configuration():
    return {
        'repositoryId': '123',
        'environments': {
            'production': {'enabled': False},
            'staging': {'enabled': True, 'clientId': 'stage', 'clientSecretSha256': 'a' * 64,
                        'coolify': {'COOLIFY_APPLICATION_UUID': 'stage-app'},
                        'healthUrl': 'https://staging.example/app-version.json',
                        'receiver': {'coolify_project': 'stage-project', 'docker_network': 'stage-network',
                                     'required_migration': '20261015120000', 'migration_approvals': []}},
        },
    }


class CoolifyWorkerStartupTests(unittest.TestCase):
    def test_one_coolify_json_generates_private_controller_and_receiver_configuration(self):
        files = worker_start.configuration_files(json.dumps(configuration()))
        controller = json.loads(files['controller.json'])
        receiver = json.loads(files['receiver.staging.json'])
        self.assertEqual(controller['audience'], 'https://deploy.alteilsolutions.com')
        self.assertNotIn('receiver', controller['environments']['staging'])
        self.assertEqual(receiver['environment'], 'staging')
        self.assertEqual(receiver['coolify_project'], 'stage-project')
        self.assertEqual(receiver['supabase_bin'], '/usr/bin/supabase')
        self.assertEqual(receiver['supabase_version'], '2.121.0')
        self.assertEqual(receiver['migration_safety_checker'], '/opt/tickit/scripts/pending-migration-safety.mjs')
        self.assertNotIn('receiver.production.json', files)

    def test_requires_receiver_configuration_only_for_enabled_environments(self):
        config = configuration()
        del config['environments']['staging']['receiver']
        with self.assertRaisesRegex(ValueError, 'receiver'):
            worker_start.configuration_files(json.dumps(config))
        config['environments']['staging']['enabled'] = False
        self.assertEqual(set(worker_start.configuration_files(json.dumps(config))), {'controller.json'})

    def test_does_not_allow_coolify_configuration_to_replace_image_executables(self):
        config = configuration()
        config['environments']['staging']['receiver']['node_bin'] = '/tmp/untrusted'
        with self.assertRaisesRegex(ValueError, 'fixed'):
            worker_start.configuration_files(json.dumps(config))

    def test_invalid_json_and_oversized_config_fail_without_logging_content(self):
        for value in ('private-secret-invalid-json', 'x' * 262145, '[]'):
            with self.assertRaises(ValueError) as result:
                worker_start.configuration_files(value)
            self.assertNotIn(value[:20], str(result.exception))

    def test_private_files_and_key_are_prepared_without_host_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker_start.write_private_files(root, {'controller.json': 'private-value'})
            self.assertEqual((root / 'controller.json').read_text(), 'private-value')
            self.assertEqual(list(root.iterdir()), [root / 'controller.json'])


if __name__ == '__main__':
    unittest.main()
