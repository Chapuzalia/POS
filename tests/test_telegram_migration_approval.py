import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('telegram_approval', Path(__file__).parents[1] / 'scripts/telegram_migration_approval.py')
telegram = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telegram)

CHAT = '-123456789'
TOKEN = '123456789:FAKE_TEST_TOKEN_WITH_MORE_THAN_25_CHARS'
COMMIT = 'a' * 40
SETTINGS = {'bot_token': TOKEN, 'chat_id': CHAT, 'timeout_seconds': 900}
SENSITIVE = [{'migration': '20261028120000_sensitive.sql', 'sha256': 'b' * 64, 'reasons': ['DROP', 'DELETE FROM']}]


class FakeTelegram:
    def __init__(self, decisions=None, member='member'):
        self.calls, self.messages = [], []
        self.decisions = list(decisions or ['deploy'])
        self.member = member
        self.sequence = 0
        self.invalid = []

    def __call__(self, method, payload):
        self.calls.append((method, payload))
        if method == 'getWebhookInfo':
            return {'url': ''}
        if method == 'getMe':
            return {'id': 777, 'is_bot': True}
        if method == 'getChatMember':
            return {'user': {'id': payload['user_id']}, 'status': 'administrator' if payload['user_id'] == 777 else self.member}
        if method == 'sendMessage':
            self.messages.append(payload)
            return {'chat': {'id': int(CHAT), 'type': 'group'}, 'message_id': len(self.messages), 'date': 100}
        if method == 'getUpdates':
            self.sequence += 1
            button = self.messages[-1]['reply_markup']['inline_keyboard'][0]
            action = self.decisions.pop(0) if self.decisions else 'deploy'
            data = button[0 if action == 'deploy' else 1]['callback_data']
            callback = {'id': f'query-{self.sequence}', 'data': data,
                        'from': {'id': 42, 'is_bot': False},
                        'message': {'chat': {'id': int(CHAT), 'type': 'group'}, 'message_id': len(self.messages), 'date': 100}}
            return self.invalid.pop(0) if self.invalid else [{'update_id': self.sequence, 'callback_query': callback}]
        if method in ('answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'):
            return True
        raise AssertionError(method)


class TelegramApprovalTests(unittest.TestCase):
    def request(self, api=None, sensitive=None, now=lambda: 0):
        audit = []
        result = telegram.request_approvals(SETTINGS, sensitive or SENSITIVE, environment='production',
                                           commit=COMMIT, audit=audit.append, api=api or FakeTelegram(), now=now)
        return result, audit

    def test_group_member_can_approve_exact_file_with_explained_reasons_and_two_buttons(self):
        api = FakeTelegram()
        result, audit = self.request(api)
        message = api.messages[0]
        self.assertEqual(message['chat_id'], CHAT)
        self.assertIn(SENSITIVE[0]['migration'], message['text'])
        self.assertIn(COMMIT, message['text'])
        self.assertIn('DROP', message['text'])
        self.assertIn('DELETE FROM', message['text'])
        self.assertIn('elimina', message['text'].lower())
        self.assertEqual([b['text'] for b in message['reply_markup']['inline_keyboard'][0]], ['Desplegar', 'Cancelar'])
        self.assertTrue(all(len(b['callback_data'].encode()) <= 64 for b in message['reply_markup']['inline_keyboard'][0]))
        self.assertEqual(result[0]['sha256'], SENSITIVE[0]['sha256'])
        self.assertEqual(result[0]['commit'], COMMIT)
        self.assertEqual(result[0]['environment'], 'production')
        self.assertEqual(audit[0]['user_id'], 42)
        self.assertNotIn(TOKEN, json.dumps(audit))
        self.assertTrue(any(method == 'editMessageReplyMarkup' for method, _ in api.calls))

    def test_cancel_aborts_the_entire_release_and_disables_buttons(self):
        api = FakeTelegram(['cancel'])
        with self.assertRaises(telegram.ApprovalCancelled):
            self.request(api)
        self.assertTrue(any(method == 'editMessageReplyMarkup' for method, _ in api.calls))

    def test_all_sensitive_files_need_approval_and_cancelling_later_discards_earlier_approvals(self):
        second = {**SENSITIVE[0], 'migration': '20261028120100_second.sql', 'sha256': 'c' * 64}
        api = FakeTelegram(['deploy', 'cancel'])
        with self.assertRaises(telegram.ApprovalCancelled):
            self.request(api, [*SENSITIVE, second])
        self.assertEqual(len(api.messages), 2)
        first = api.messages[0]['reply_markup']['inline_keyboard'][0][0]['callback_data']
        second_data = api.messages[1]['reply_markup']['inline_keyboard'][0][0]['callback_data']
        self.assertNotEqual(first, second_data)

    def test_foreign_chat_message_nonce_and_nonmembers_cannot_approve(self):
        for change in ('chat', 'message', 'nonce', 'bot', 'nonmember'):
            api = FakeTelegram(member='left' if change == 'nonmember' else 'member')
            original = api.__class__.__call__
            ticks = [0]
            def now():
                ticks[0] += 1
                return ticks[0] * 200
            def changed(method, payload):
                result = original(api, method, payload)
                if method == 'getUpdates':
                    callback = result[0]['callback_query']
                    if change == 'chat': callback['message']['chat']['id'] = -999
                    if change == 'message': callback['message']['message_id'] = 999
                    if change == 'nonce': callback['data'] = '0' * 32 + ':deploy'
                    if change == 'bot': callback['from']['is_bot'] = True
                return result
            # All following responses stay unauthorized; no network/sleep is used.
            with self.subTest(change=change), self.assertRaises(telegram.ApprovalCancelled):
                self.request(changed, now=now)

    def test_expiry_cancels_without_granting_approval(self):
        values = iter([0, 1, 901])
        api = FakeTelegram()
        def silent(method, payload):
            return [] if method == 'getUpdates' else api(method, payload)
        with self.assertRaises(telegram.ApprovalCancelled):
            self.request(silent, now=lambda: next(values, 901))
        self.assertTrue(any(method == 'editMessageReplyMarkup' for method, _ in api.calls))

    def test_bot_needs_membership_verification_permissions_and_no_existing_webhook(self):
        for mode in ('webhook', 'not-admin', 'outage'):
            api = FakeTelegram()
            def failing(method, payload):
                if mode == 'webhook' and method == 'getWebhookInfo': return {'url': 'https://another-app.invalid'}
                if mode == 'not-admin' and method == 'getChatMember': return {'user': {'id': 777}, 'status': 'member'}
                if mode == 'outage': raise telegram.ApprovalError('Telegram unavailable')
                return api(method, payload)
            with self.subTest(mode=mode), self.assertRaises(telegram.ApprovalError):
                self.request(failing)
            self.assertFalse(api.messages)

    def test_transport_does_not_follow_redirects_or_expose_token_in_errors(self):
        error = urllib.error.URLError('https://api.telegram.org/bot' + TOKEN + '/sendMessage')
        opener = type('Opener', (), {'open': lambda *args, **kwargs: (_ for _ in ()).throw(error)})()
        with patch.object(telegram.urllib.request, 'build_opener', return_value=opener) as build:
            with self.assertRaises(telegram.ApprovalError) as caught:
                telegram.TelegramClient(TOKEN)('sendMessage', {'text': 'test'})
        self.assertTrue(any(isinstance(handler, telegram.NoRedirect) for handler in build.call_args.args))
        self.assertIsNone(telegram.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://attacker.invalid'))
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_long_reason_reports_keep_every_reason_and_only_last_part_has_buttons(self):
        api = FakeTelegram()
        reasons = [f'RISK {index} ' + 'details ' * 40 for index in range(30)]
        self.request(api, [{**SENSITIVE[0], 'reasons': reasons}])
        self.assertGreater(len(api.messages), 1)
        self.assertTrue(all(len(message['text']) <= 4096 for message in api.messages))
        self.assertTrue(all(SENSITIVE[0]['migration'] in message['text'] for message in api.messages))
        self.assertTrue(all('reply_markup' not in message for message in api.messages[:-1]))
        joined = ''.join(message['text'] for message in api.messages)
        for index in range(30): self.assertIn(f'RISK {index}', joined)

    def test_old_nonce_cannot_authorize_the_next_sensitive_file(self):
        api = FakeTelegram(['deploy', 'deploy', 'deploy'])
        second = {**SENSITIVE[0], 'migration': '20261028120100_second.sql', 'sha256': 'c' * 64}
        stale_sent = False
        def replay(method, payload):
            nonlocal stale_sent
            result = api(method, payload)
            if method == 'getUpdates' and len(api.messages) == 2 and not stale_sent:
                result[0]['callback_query']['data'] = api.messages[0]['reply_markup']['inline_keyboard'][0][0]['callback_data']
                stale_sent = True
            return result
        result, audit = self.request(replay, [*SENSITIVE, second])
        self.assertTrue(stale_sent)
        self.assertEqual(len(result), 2)
        self.assertEqual(len(audit), 2)
        self.assertEqual(len([m for m, _ in api.calls if m == 'getUpdates']), 3)


if __name__ == '__main__':
    unittest.main()
