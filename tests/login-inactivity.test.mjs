import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const loginActivity = readFileSync(
  new URL('../src/features/session/hooks/useLoginActivity.ts', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('../supabase/migrations/20260826120000_separate_login_activity_lease.sql', import.meta.url),
  'utf8',
)
const consolidatedDatabase = readFileSync(
  new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url),
  'utf8',
)

test('el cliente cierra la sesion tras cuatro horas de inactividad', () => {
  assert.match(loginActivity, /const inactivityMs = 4 \* 60 \* 60 \* 1000/)
  assert.doesNotMatch(loginActivity, /30 minutos sin actividad/)
  assert.equal(
    (loginActivity.match(/4 horas sin actividad/g) ?? []).length,
    2,
  )
})

test('el heartbeat depende exclusivamente de actividad y se limita a uno cada 30 segundos', () => {
  assert.match(loginActivity, /const heartbeatThrottleMs = 30_000/)
  assert.match(loginActivity, /window\.addEventListener\('pointerdown', recordActivity/)
  assert.match(loginActivity, /window\.addEventListener\('keydown', recordActivity/)
  assert.match(loginActivity, /window\.addEventListener\('wheel', recordActivity/)
  assert.match(loginActivity, /isOnline && now - activity\.lastHeartbeatAt >= heartbeatThrottleMs/)
  assert.match(loginActivity, /activity\.lastHeartbeatAt = now\s+void validateLease\(true\)/)
  assert.doesNotMatch(loginActivity, /setInterval/)
})

test('las comprobaciones no renuevan el lease y la actividad puede reclamar uno expirado', () => {
  assert.match(loginActivity, /heartbeatOnActivity \? await heartbeatLoginLease\(\) : await checkLoginLease\(\)/)
  assert.match(loginActivity, /if \(heartbeatOnActivity && !ownsLease\)/)
  assert.match(loginActivity, /ownsLease = await claimLoginLease\(false\)/)
})

test('la concesion de actividad dura dos minutos sin cambiar la sesion de cuatro horas', () => {
  assert.match(migration, /alter column expires_at set default \(now\(\) \+ interval '2 minutes'\)/i)
  assert.match(migration, /create function public\.claim_user_login\([\s\S]*?p_client_id uuid,[\s\S]*?p_device_id uuid,[\s\S]*?p_allow_same_device boolean/i)
  assert.match(migration, /create function public\.force_claim_user_login\(p_client_id uuid, p_device_id uuid\)/i)
  assert.match(migration, /create function public\.heartbeat_user_login\(p_client_id uuid, p_device_id uuid\)/i)
  assert.doesNotMatch(migration, /interval '4 hours'/i)
})

test('el esquema consolidado historico permanece sin modificar', () => {
  assert.doesNotMatch(consolidatedDatabase, /interval '30 minutes'/i)
  assert.doesNotMatch(consolidatedDatabase, /'00:30:00'::interval/i)
  assert.equal((consolidatedDatabase.match(/interval '4 hours'/g) ?? []).length, 3)
  assert.match(consolidatedDatabase, /'04:00:00'::interval/i)
})
