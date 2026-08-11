import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const loginActivity = readFileSync(
  new URL('../src/features/session/hooks/useLoginActivity.ts', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('../supabase/migrations/20260811140000_extend_login_inactivity_to_four_hours.sql', import.meta.url),
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

test('la concesion de login permanece alineada con las cuatro horas del cliente', () => {
  assert.match(migration, /alter column expires_at set default \(now\(\) \+ interval '4 hours'\)/i)
  assert.match(migration, /create or replace function public\.claim_user_login/i)
  assert.match(migration, /create or replace function public\.force_claim_user_login/i)
  assert.match(migration, /create or replace function public\.heartbeat_user_login/i)
  assert.equal((migration.match(/interval '4 hours'/g) ?? []).length, 6)
})

test('el esquema consolidado tambien usa cuatro horas', () => {
  assert.doesNotMatch(consolidatedDatabase, /interval '30 minutes'/i)
  assert.doesNotMatch(consolidatedDatabase, /'00:30:00'::interval/i)
  assert.equal((consolidatedDatabase.match(/interval '4 hours'/g) ?? []).length, 3)
  assert.match(consolidatedDatabase, /'04:00:00'::interval/i)
})
