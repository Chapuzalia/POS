"""One-use Telegram approval before any sensitive SQL is applied.

Long polling keeps the existing private controller endpoints unchanged. Only
current members of the configured group can decide. Nothing is auto-approved
after an outage, timeout or receiver restart.
"""
from datetime import datetime, timedelta, timezone
import json
import re
import secrets
import time
import urllib.error
import urllib.request


class ApprovalError(Exception):
    pass


class ApprovalCancelled(ApprovalError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TelegramClient:
    def __init__(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[0-9]{6,}:[A-Za-z0-9_-]{25,100}', token):
            raise ApprovalError('Configure the private Telegram bot token in Coolify.')
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def __call__(self, method, payload):
        if method not in {'getWebhookInfo', 'getMe', 'getChatMember', 'sendMessage', 'getUpdates',
                          'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText'}:
            raise ApprovalError('Unsupported Telegram operation.')
        request = urllib.request.Request(f'https://api.telegram.org/bot{self.token}/{method}',
                                         data=json.dumps(payload).encode(), method='POST',
                                         headers={'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                body = response.read(1024 * 1024 + 1)
                if response.status != 200 or len(body) > 1024 * 1024:
                    raise ValueError()
            result = json.loads(body)
            if not isinstance(result, dict) or result.get('ok') is not True or 'result' not in result:
                raise ValueError()
            return result['result']
        except (OSError, ValueError, urllib.error.URLError):
            # urllib errors include the URL (and therefore the token). Never log them.
            raise ApprovalError('Telegram unavailable; no SQL approval was granted.') from None


REASONS = {
    'DROP': 'Elimina objetos del esquema y puede destruir datos.',
    'TRUNCATE': 'Vacía tablas completas y elimina sus registros.',
    'DELETE FROM': 'Elimina filas de las tablas afectadas.',
    'ANONYMOUS DO BLOCK': 'Ejecuta un bloque SQL cuyo contenido necesita revisión manual.',
    'ANONYMOUS DO BLOCK REQUIRES ROOT CONTENT APPROVAL': 'El bloque DO puede ejecutar SQL dinámico; requiere revisión del contenido exacto.',
    'CALL PROCEDURE': 'Ejecuta un procedimiento que puede modificar datos o contratos.',
    'RENAME': 'Renombra objetos que pueden estar usando clientes instalados.',
    'ALTER COLUMN TYPE': 'Cambia tipos de datos y puede convertir valores o bloquear escrituras.',
    'SET NOT NULL': 'Impone una restricción que puede rechazar escrituras existentes.',
    'ADD NOT NULL COLUMN': 'Añade una columna obligatoria que puede romper clientes anteriores.',
    'CREATE OR REPLACE ROUTINE': 'Sustituye lógica de funciones o RPC que pueden estar en uso.',
    'CREATE OR REPLACE VIEW': 'Cambia una vista y el contrato de las consultas existentes.',
    'ALTER API/TYPE': 'Modifica una API o tipo que pueden usar versiones anteriores.',
    'REVOKE': 'Retira permisos y puede impedir operaciones de usuarios o dispositivos.',
    'WEAKEN RLS': 'Modifica protecciones RLS y puede afectar el aislamiento de tenants.',
    'MOVE SCHEMA': 'Mueve objetos y puede romper referencias existentes.',
    'MISSING OR INVALID MIGRATION SAFETY DECLARATION': 'No declara correctamente si el cambio es expand o contract.',
    'INVALID EXPAND HEADER': 'La cabecera expand no cumple el formato de seguridad.',
    'MISSING MIGRATION CONTRACT REFERENCE': 'No identifica qué contrato antiguo pretende retirar.',
    'MIGRATION CONTRACT IS NOT REGISTERED IN BASELINE': 'No se ha demostrado la fase expand y la compatibilidad del contrato que se retira.',
    'INVALID CONTRACT HEADER': 'La cabecera contract o sus límites de ejecución no cumplen el formato requerido.',
    'MISSING REVIEW REASON': 'Falta la justificación de la revisión de seguridad.',
    'REVIEWED CHECK REPLACEMENT MUST MATCH AN APPROVED COMPATIBLE MIGRATION': 'La sustitución de una restricción CHECK no coincide con una variante compatible revisada.',
    'REVIEWED REVOKE MAY ONLY REMOVE PUBLIC/ANON ACCESS OR AUTHENTICATED ACCESS FROM FUNCTIONS CREATED IN THE SAME MIGRATION': 'La retirada de permisos excede las excepciones seguras previstas.',
    'REVIEWED REVOKE MUST GRANT FUNCTION EXECUTE TO AUTHENTICATED': 'Retira permisos de una RPC sin conservar la ejecución para usuarios autenticados.',
    'MISSING OR INVALID lock_timeout (required: 5s)': 'No limita correctamente la espera de bloqueos a 5 segundos.',
    'MISSING OR INVALID statement_timeout (required: 5min)': 'No limita correctamente la ejecución SQL a 5 minutos.',
    'CHECK/FOREIGN KEY CONSTRAINT WITHOUT NOT VALID': 'La validación inmediata de una restricción puede bloquear operaciones.',
    'BLOCKING UNIQUE/PRIMARY/EXCLUDE CONSTRAINT': 'Añade una restricción sin un índice preparado y puede bloquear escrituras.',
}


def message_text(item, environment, commit, index, total):
    reasons = '\n'.join(f"• {reason}: {REASONS.get(reason, 'El analizador exige revisar esta condición antes de ejecutar SQL.')}"
                        for reason in item['reasons'])
    return (f'⚠️ Tickit POS — Migración sensible ({index}/{total})\n'
            f'Entorno: {environment}\nCommit: {commit}\nMigración: {item["migration"]}\n'
            f'Contenido SHA-256: {item["sha256"]}\n\nMotivos detectados:\n{reasons}\n\n'
            f'Revisar SQL: https://github.com/Chapuzalia/POS/blob/{commit}/supabase/migrations/{item["migration"]}\n\n'
            'Desplegar autoriza este archivo y commit. Todas las migraciones sensibles deben aprobarse antes de ejecutar SQL. '
            'Cancelar detiene el despliegue completo. Cualquier miembro actual del grupo puede responder. '
            'La solicitud caduca en un máximo de 15 minutos.')


def request_approvals(settings, sensitive, *, environment, commit, audit, api=None, now=time.monotonic):
    if (not isinstance(settings, dict) or not re.fullmatch(r'-[1-9][0-9]{0,18}', str(settings.get('chat_id', '')))
            or environment not in ('production', 'staging') or not re.fullmatch(r'[0-9a-f]{40}', commit or '')):
        raise ApprovalError('Configure Telegram group approval for this deployment.')
    timeout = settings.get('timeout_seconds', 900)
    if type(timeout) is not int or not 30 <= timeout <= 900:
        raise ApprovalError('Telegram approval timeout must be between 30 and 900 seconds.')
    if not isinstance(sensitive, list) or not sensitive:
        raise ApprovalError('Missing sensitive migration report.')
    names = set()
    for item in sensitive:
        if (not isinstance(item, dict) or not re.fullmatch(r'[0-9]{14}_[A-Za-z0-9_-]+\.sql', item.get('migration', ''))
                or item['migration'] in names or not re.fullmatch(r'[0-9a-f]{64}', item.get('sha256', ''))
                or not isinstance(item.get('reasons'), list) or not item['reasons']
                or any(not isinstance(reason, str) or not 1 <= len(reason) <= 512 for reason in item['reasons'])):
            raise ApprovalError('Invalid sensitive migration report.')
        names.add(item['migration'])
    api = api or TelegramClient(settings.get('bot_token'))
    chat = str(settings['chat_id'])
    webhook = api('getWebhookInfo', {})
    if not isinstance(webhook, dict) or webhook.get('url') != '':
        raise ApprovalError('This Telegram bot has an active webhook; use a dedicated bot without a webhook.')
    bot = api('getMe', {})
    if not isinstance(bot, dict) or type(bot.get('id')) is not int or bot.get('is_bot') is not True:
        raise ApprovalError('Telegram bot identity could not be verified.')
    membership = api('getChatMember', {'chat_id': chat, 'user_id': bot['id']})
    if (not isinstance(membership, dict) or membership.get('user', {}).get('id') != bot['id']
            or membership.get('status') not in ('administrator', 'creator')):
        raise ApprovalError('Make the bot an administrator to verify current group membership reliably.')
    deadline = now() + timeout
    offset = 0
    accepted = []
    for index, item in enumerate(sensitive, 1):
        nonce = secrets.token_hex(16)
        text = message_text(item, environment, commit, index, len(sensitive))
        # Avoid cutting off a detected reason. Long reports are sent in full;
        # only the final message has actionable buttons.
        chunks = [text] if len(text) <= 3500 else [
            f'Migración: {item["migration"]}\nEntorno: {environment}\nCommit: {commit}\n'
            f'Informe (parte {part + 1}):\n' + text[start:start + 2700]
            for part, start in enumerate(range(0, len(text), 2700))
        ]
        buttons = {'inline_keyboard': [[{'text': 'Desplegar', 'callback_data': nonce + ':deploy'},
                                       {'text': 'Cancelar', 'callback_data': nonce + ':cancel'}]]}
        for part, chunk in enumerate(chunks):
            payload = {'chat_id': chat, 'text': chunk, 'protect_content': True, 'link_preview_options': {'is_disabled': True}}
            if part == len(chunks) - 1:
                payload['reply_markup'] = buttons
            message = api('sendMessage', payload)
            if (not isinstance(message, dict) or str(message.get('chat', {}).get('id')) != chat
                    or message.get('chat', {}).get('type') not in ('group', 'supergroup')
                    or type(message.get('message_id')) is not int or message['message_id'] <= 0):
                raise ApprovalError('Telegram did not confirm the expected group message.')
        message_id = message['message_id']

        def finish(status, user_id=None):
            audit({'decision': status, 'environment': environment, 'commit': commit,
                   'migration': item['migration'], 'sha256': item['sha256'], 'user_id': user_id,
                   'chat_id': chat, 'message_id': message_id})
            for method, payload in [
                ('editMessageReplyMarkup', {'chat_id': chat, 'message_id': message_id, 'reply_markup': {'inline_keyboard': []}}),
                ('editMessageText', {'chat_id': chat, 'message_id': message_id,
                                     'text': chunks[-1] + f'\n\nEstado: {status}' + (f' · usuario {user_id}' if user_id else '')}),
            ]:
                try:
                    api(method, payload)
                except ApprovalError:
                    pass  # A valid, audited decision is not undone by an acknowledgement outage.

        try:
            while now() < deadline:
                updates = api('getUpdates', {'offset': offset, 'timeout': 20, 'limit': 100, 'allowed_updates': ['callback_query']})
                if not isinstance(updates, list) or len(updates) > 100:
                    raise ApprovalError('Telegram returned an invalid update batch.')
                for update in updates:
                    if not isinstance(update, dict) or type(update.get('update_id')) is not int or update['update_id'] < offset:
                        continue
                    offset = update['update_id'] + 1
                    query = update.get('callback_query')
                    if not isinstance(query, dict):
                        continue
                    actor, source = query.get('from'), query.get('message')
                    if (not isinstance(actor, dict) or type(actor.get('id')) is not int or actor['id'] <= 0 or actor.get('is_bot') is not False
                            or not isinstance(source, dict) or str(source.get('chat', {}).get('id')) != chat
                            or source.get('message_id') != message_id or not isinstance(query.get('data'), str)
                            or not isinstance(query.get('id'), str) or not query['id']
                            or query['data'] not in (nonce + ':deploy', nonce + ':cancel')):
                        continue
                    member = api('getChatMember', {'chat_id': chat, 'user_id': actor['id']})
                    if (not isinstance(member, dict) or member.get('user', {}).get('id') != actor['id']
                            or not (member.get('status') in ('creator', 'administrator', 'member')
                                    or (member.get('status') == 'restricted' and member.get('is_member') is True))):
                        continue
                    if now() >= deadline:
                        break
                    decision = 'aprobada' if query['data'].endswith(':deploy') else 'cancelada'
                    finish(decision, actor['id'])
                    try:
                        api('answerCallbackQuery', {'callback_query_id': query['id'], 'text': f'Migración {decision}.'})
                    except ApprovalError:
                        pass
                    if decision == 'cancelada':
                        raise ApprovalCancelled('Deployment cancelled in Telegram before applying SQL.')
                    accepted.append({**item, 'environment': environment, 'commit': commit,
                                     'reason': f'Telegram group approval by user {actor["id"]}'})
                    break
                else:
                    continue
                if len(accepted) == index:
                    break
            else:
                finish('caducada')
                raise ApprovalCancelled('Telegram approval expired; no SQL was applied.')
            if len(accepted) != index:
                finish('caducada')
                raise ApprovalCancelled('Telegram approval expired; no SQL was applied.')
        except ApprovalCancelled:
            raise
        except ApprovalError:
            finish('error de comunicación; despliegue detenido')
            raise
    expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).strftime('%Y-%m-%dT%H:%M:%SZ')
    return [{'environment': environment, 'migration': item['migration'], 'sha256': item['sha256'],
             'commit': commit, 'reason': item['reason'], 'expires_at': expires} for item in accepted]
