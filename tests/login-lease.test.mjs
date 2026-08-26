import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const service = readFileSync(
  new URL('../src/services/loginLeaseService.ts', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('../supabase/migrations/20260826120000_separate_login_activity_lease.sql', import.meta.url),
  'utf8',
)

test('usa un deviceId persistente y un instanceId temporal separados', () => {
  assert.match(service, /const deviceIdKey = 'club-pos:login-device-id'/)
  assert.match(service, /const instanceIdKey = 'club-pos:login-instance-id'/)
  assert.match(service, /localStorage\.getItem\(deviceIdKey\)/)
  assert.match(service, /sessionStorage\.getItem\(instanceIdKey\)/)
  assert.match(service, /legacyClientIdKey/)
})

test('todas las RPC identifican tanto el dispositivo como la instancia', () => {
  for (const rpc of [
    'claim_user_login',
    'force_claim_user_login',
    'heartbeat_user_login',
    'check_user_login',
    'release_user_login',
  ]) {
    const call = service.slice(service.indexOf(`supabase.rpc('${rpc}'`))
    assert.match(call.slice(0, 240), /p_client_id:/)
    assert.match(call.slice(0, 240), /p_device_id:/)
  }
})

test('claim solo sustituye otro dispositivo cuando el lease ha expirado', () => {
  assert.match(migration, /where \(p_allow_same_device and public\.user_login_leases\.device_id = excluded\.device_id\)\s+or public\.user_login_leases\.expires_at <= now\(\)/i)
  assert.match(service, /export async function claimLoginLease\(allowSameDevice = true\)/)
  assert.match(service, /p_allow_same_device: allowSameDevice/)
})

test('heartbeat y release exigen seguir siendo el propietario exacto', () => {
  assert.match(migration, /create function public\.heartbeat_user_login[\s\S]*?and auth_session_id = current_session_id[\s\S]*?and client_id = p_client_id[\s\S]*?and device_id = p_device_id[\s\S]*?and expires_at > now\(\)/i)
  assert.match(migration, /create function public\.release_user_login[\s\S]*?and auth_session_id = \(auth\.jwt\(\) ->> 'session_id'\)[\s\S]*?and client_id = p_client_id[\s\S]*?and device_id = p_device_id/i)
})

test('check distingue un lease expirado de otro propietario activo sin renovarlo', () => {
  const checkFunction = migration.slice(
    migration.indexOf('create function public.check_user_login'),
    migration.indexOf('create function public.release_user_login'),
  )
  assert.match(checkFunction, /or not exists/i)
  assert.match(checkFunction, /expires_at > now\(\)/i)
  assert.doesNotMatch(checkFunction, /update public\.user_login_leases/i)
})
