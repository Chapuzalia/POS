"""Private stdin/stdout transport for seed-staging-demos.mjs; no secrets in argv."""
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

PROJECT = 'irsdd2liytrh7dttjr5rzj3j'
API = 'https://pre-api-tpv.alteilsolutions.com'
SEED = 'tickit-staging-demos-v1'


def inspect(service):
    result = subprocess.run(['sudo', '-n', 'docker', 'inspect', service + '-' + PROJECT], capture_output=True, text=True, check=True)
    container = json.loads(result.stdout)[0]
    if container['Config']['Labels'].get('com.docker.compose.project') != PROJECT or not container['State']['Running']:
        raise ValueError('STAGING_CONTAINER_IDENTITY_MISMATCH')
    return container


def sql(query):
    result = subprocess.run([
        'sudo', '-n', 'docker', 'exec', '-i', 'supabase-db-' + PROJECT,
        'psql', '-X', '-qAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    ], input="set tickit.demo_target='" + PROJECT + "';\n" + query, capture_output=True, text=True)
    if result.returncode:
        # SQL contains only fixture values and IDs, never passwords or API keys.
        raise ValueError('STAGING_SQL_FAILED: ' + result.stderr[-2500:])
    return result.stdout.strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def request(path, key, body=None, token=None, method=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + (token or key), 'Content-Type': 'application/json', 'User-Agent': 'tickit-staging-demo/1'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        # Auth responses and headers can contain sensitive details. Only expose status.
        raise ValueError('STAGING_API_HTTP_' + str(error.code) + ': ' + path.split('?')[0]) from None


def main():
    payload = json.load(sys.stdin)
    if payload.get('project') != PROJECT or payload.get('api') != API:
        raise ValueError('STAGING_TARGET_MISMATCH')
    inspect('supabase-db')
    gateway = inspect('supabase-envoy')
    env = dict(item.split('=', 1) for item in gateway['Config']['Env'])
    if (env.get('SUPABASE_PUBLIC_URL', '').rstrip('/') != API
            or env.get('API_EXTERNAL_URL', '').rstrip('/') not in (API, API + '/auth/v1')):
        raise ValueError('STAGING_API_IDENTITY_MISMATCH')
    action = payload['action']
    if action == 'sql':
        return {'output': sql(payload['sql'])}
    service_key = env['SERVICE_ROLE_KEY']
    anon_key = env['ANON_KEY']
    if action in ('auth', 'passwords'):
        accounts = payload['accounts']
        existing = {}
        # Validate every collision before creating any user. Do not adopt or reset
        # unrelated users, even if their email happens to match the fixture.
        for account in accounts:
            raw = sql('select coalesce(json_agg(u),\'[]\') from (select id,raw_app_meta_data from auth.users where lower(email)=' + literal(account['email']) + ') u;')
            users = json.loads(raw)
            if users:
                user = users[0]
                metadata = user['raw_app_meta_data'] or {}
                if metadata.get('demo_seed') != SEED or metadata.get('demo_account') != account['key']:
                    raise ValueError('DEMO_AUTH_COLLISION: ' + account['email'])
                if account.get('id') and user['id'] != account['id']:
                    raise ValueError('DEMO_AUTH_ID_MISMATCH')
                foreign = sql('select count(*) from public.tenant_memberships where user_id=' + literal(user['id']) + ' and tenant_id<>' + literal(account['tenantId']) + ';')
                if int(foreign):
                    raise ValueError('DEMO_USER_HAS_FOREIGN_MEMBERSHIP')
                existing[account['key']] = user['id']
            elif action == 'passwords':
                raise ValueError('DEMO_PASSWORD_USER_NOT_FOUND')
        if action == 'passwords':
            if any(not a.get('id') or existing[a['key']] != a['id'] or not 8 <= len(a.get('password', '')) <= 128 for a in accounts):
                raise ValueError('DEMO_PASSWORD_REQUEST_INVALID')
            for account in accounts:
                request('/auth/v1/admin/users/' + account['id'], service_key,
                        {'password': account['password']}, method='PUT')
            return {'updated': len(accounts)}
        result = []
        for account in accounts:
            user_id = existing.get(account['key'])
            if not user_id:
                user = request('/auth/v1/admin/users', service_key, {
                    'email': account['email'], 'password': account['password'], 'email_confirm': True,
                    'user_metadata': {'full_name': account['name']},
                    'app_metadata': {'demo_seed': SEED, 'demo_account': account['key']},
                })
                user_id = user['id']
            result.append({'key': account['key'], 'id': user_id})
        return {'users': result}
    if action == 'history-stats':
        results = []
        zone = ZoneInfo('Europe/Madrid')
        start = datetime.fromisoformat(payload['startDate']).replace(tzinfo=zone)
        end = datetime.fromisoformat(payload['endDate']).replace(tzinfo=zone)
        unique_venues = {s['venueId']: s['tenantId'] for s in payload['sessions']}
        for account in payload['accounts']:
            session = request('/auth/v1/token?grant_type=password', anon_key, {'email': account['email'], 'password': account['password']})
            token = session['access_token']
            try:
                for venue_id, tenant_id in unique_venues.items():
                    if tenant_id != account['tenantId']:
                        continue
                    periods = []
                    for period_start, period_end, kind in [(start, end, 'custom'), (end.replace(day=1), end, 'month'), ((end.replace(day=1)-timedelta(days=1)).replace(day=1), end.replace(day=1)-timedelta(days=1), 'month')]:
                        body = {'p_tenant_id': tenant_id, 'p_venue_id': venue_id, 'p_period_kind': kind,
                                'p_period_start_date': period_start.date().isoformat(), 'p_period_end_date': period_end.date().isoformat(), 'p_effective_end_date': period_end.date().isoformat(),
                                'p_period_start': period_start.isoformat(), 'p_period_end': (period_end+timedelta(days=1)).isoformat(), 'p_time_zone': 'Europe/Madrid', 'p_day_change_time': None}
                        stats = request('/rest/v1/rpc/crm_stats_period', anon_key, body, token=token)
                        tenders = stats.get('byPayment', [])
                        if (stats.get('monthTicketCount', 0) <= 0 or stats.get('monthSalesCents', 0) <= 0
                                or {p['method'] for p in tenders} != {'cash', 'card'}
                                or sum(p['totalCents'] for p in tenders) != stats['monthSalesCents']
                                or not stats.get('salesByCategory') or any(c['label'] == 'Sin categoría' for c in stats['salesByCategory'])
                                or not stats.get('topProducts')):
                            raise ValueError('DEMO_HISTORY_CRM_STATS_FAILED')
                        periods.append({'start': period_start.date().isoformat(), 'end': period_end.date().isoformat(), 'tickets': stats['monthTicketCount'], 'totalCents': stats['monthSalesCents'], 'discountCents': stats['discountsCents'], 'byPayment': tenders, 'categories': len(stats['salesByCategory'])})
                    live = request('/rest/v1/rpc/crm_stats_live', anon_key, {'p_tenant_id': tenant_id, 'p_venue_id': venue_id, 'p_day_start': end.isoformat(), 'p_day_end': (end+timedelta(days=1)).isoformat()}, token=token)
                    if live['dayActivity']['ticketCount'] <= 0:
                        raise ValueError('DEMO_HISTORY_TODAY_EMPTY')
                    foreign = next(v for v, t in unique_venues.items() if t != tenant_id)
                    denied = request('/rest/v1/rpc/crm_stats_period', anon_key, {**body, 'p_venue_id': foreign}, token=token)
                    if denied['monthTicketCount'] != 0 or denied['monthSalesCents'] != 0:
                        raise ValueError('DEMO_HISTORY_STATS_ISOLATION_FAILED')
                    results.append({'venueId': venue_id, 'periods': periods, 'today': live['dayActivity']})
            finally:
                request('/auth/v1/logout?scope=local', anon_key, token=token, method='POST')
        return {'verified': results}
    if action == 'verify':
        results = []
        for account in payload['accounts']:
            session = request('/auth/v1/token?grant_type=password', anon_key, {'email': account['email'], 'password': account['password']})
            token = session['access_token']
            try:
                if session['user']['id'] != account['id']:
                    raise ValueError('DEMO_LOGIN_ID_MISMATCH')
                visible = {}
                for table, fields in [('tenants', 'id'), ('venues', 'id,tenant_id'), ('products', 'id,tenant_id,venue_id'), ('devices', 'id,tenant_id,venue_id')]:
                    rows = request('/rest/v1/' + table + '?select=' + fields, anon_key, token=token)
                    if not rows or any((row['id'] if table == 'tenants' else row['tenant_id']) != account['tenantId'] for row in rows):
                        raise ValueError('DEMO_RLS_TENANT_FAILED: ' + account['email'] + '/' + table)
                    if account.get('deviceId'):
                        if table in ('venues', 'products', 'devices') and any((row['id'] if table == 'venues' else row['venue_id']) != account['venueId'] for row in rows):
                            raise ValueError('DEMO_RLS_VENUE_FAILED')
                        if table == 'devices' and {row['id'] for row in rows} != {account['deviceId']}:
                            raise ValueError('DEMO_RLS_DEVICE_FAILED')
                    visible[table] = len(rows)
                # Explicit cross-tenant query, in addition to unfiltered lists.
                foreign = next(t for t in payload['tenantIds'] if t != account['tenantId'])
                if request('/rest/v1/products?select=id&tenant_id=eq.' + foreign, anon_key, token=token):
                    raise ValueError('DEMO_RLS_FOREIGN_READ_FAILED')
                results.append({'email': account['email'], 'role': account['role'], 'visible': visible})
            finally:
                request('/auth/v1/logout?scope=local', anon_key, token=token, method='POST')
        return {'verified': results}
    raise ValueError('UNKNOWN_DEMO_ACTION')


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as error:
    # Do not print process objects, request bodies, tokens, env or tracebacks.
    message = str(error) if isinstance(error, ValueError) else type(error).__name__
    print(json.dumps({'error': message}), file=sys.stderr)
    sys.exit(1)
