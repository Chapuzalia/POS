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
  assert.match(loginActivity, /inactivityMs\s*=\s*4 \* 60 \* 60 \* 1000/)
  assert.doesNotMatch(loginActivity, /inactivityMs\s*=\s*30 \* 60 \* 1000/)
})

test('el heartbeat depende exclusivamente de actividad y se limita a uno cada 30 segundos', () => {
  assert.match(loginActivity, /heartbeatThrottleMs\s*=\s*30_000/)
  assert.doesNotMatch(loginActivity, /setInterval\s*\(/)
})

test('las comprobaciones no renuevan el lease y la actividad puede reclamar uno expirado', () => {
  assert.ok(loginActivity.includes('heartbeatLoginLease()'))
  assert.ok(loginActivity.includes('checkLoginLease()'))
  assert.ok(loginActivity.includes('claimLoginLease(false)'))
})

test('la concesion de actividad dura dos minutos sin cambiar la sesion de cuatro horas', () => {
  assert.match(migration, /alter column expires_at set default \(now\(\) \+ interval '2 minutes'\)/i)
  assert.ok(migration.includes('public.claim_user_login('))
  assert.ok(migration.includes('public.force_claim_user_login('))
  assert.ok(migration.includes('public.heartbeat_user_login('))
  assert.doesNotMatch(migration, /interval '4 hours'/i)
})

test('el esquema consolidado historico permanece sin modificar', () => {
  assert.doesNotMatch(consolidatedDatabase, /interval '30 minutes'/i)
  assert.doesNotMatch(consolidatedDatabase, /'00:30:00'::interval/i)
  assert.equal((consolidatedDatabase.match(/interval '4 hours'/g) ?? []).length, 3)
  assert.match(consolidatedDatabase, /'04:00:00'::interval/i)
})
