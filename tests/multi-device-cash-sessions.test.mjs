import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('la caja elegida por un satelite persiste durante esa sesion y se restaura por seleccion', async () => {
  const [migration, schema, posService, lifecycle] = await Promise.all([
    readFile(new URL('supabase/migrations/20260811210000_persist_device_cash_session_selection.sql', root), 'utf8'),
    readFile(new URL('supabase/0.Complete_Database_24-07-26.sql', root), 'utf8'),
    readFile(new URL('src/services/posService.ts', root), 'utf8'),
    readFile(new URL('src/features/cash-registers/services/cashSessionLifecycle.ts', root), 'utf8'),
  ])

  assert.match(migration, /active_cash_session_id uuid/i)
  assert.match(migration, /foreign key \(active_cash_session_id\)[\s\S]*references public\.cash_sessions\(id\)[\s\S]*on delete set null/i)
  assert.match(migration, /create index if not exists devices_active_cash_session_idx/i)
  assert.match(migration, /function public\.select_device_cash_session/i)
  assert.match(migration, /session_row\.status <> 'open'/i)
  assert.match(migration, /device_row\.venue_id <> session_row\.venue_id/i)
  assert.match(migration, /user_has_device_access/i)
  const selectionFunction = migration.match(/create or replace function public\.select_device_cash_session[\s\S]*?\n\$\$;/i)?.[0] ?? ''
  assert.doesNotMatch(selectionFunction, /default_cash_register_id/i)
  assert.match(schema, /active_cash_session_id uuid/i)
  assert.match(schema, /function public\.select_device_cash_session/i)
  assert.match(schema, /devices_active_cash_session_id_fkey/i)
  assert.match(lifecycle, /await selectCashRegisterSession\(context, session\.id\)/)
  assert.match(posService, /devices!devices_active_cash_session_id_fkey!inner/)
  assert.match(posService, /\.eq\('selected_by\.id', context\.deviceId\)/)
  assert.doesNotMatch(posService.match(/export async function loadOpenCashSession[\s\S]*?\n}\n/)?.[0] ?? '', /opened_by_device_id', context\.deviceId/)
})

test('la vinculacion termina al cerrar caja y no se reutiliza en la siguiente apertura', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260811210000_persist_device_cash_session_selection.sql', root), 'utf8')

  const openFunction = migration.match(/create or replace function public\.open_cash_register_session[\s\S]*?\n\$\$;/i)?.[0] ?? ''
  assert.match(openFunction, /set active_cash_session_id = new_session_id[\s\S]*where id = device_row\.id/i)
  assert.doesNotMatch(openFunction, /default_cash_register_id = register_row\.id/i)
  assert.match(migration, /clear_closed_cash_session_device_selections[\s\S]*set active_cash_session_id = null[\s\S]*where active_cash_session_id = new\.id/i)
  assert.match(migration, /where session\.opened_by_device_id = device\.id[\s\S]*session\.status = 'open'/i)
})

test('ningun dispositivo entra automaticamente en la unica caja abierta', async () => {
  const options = await readFile(new URL('src/features/cash-registers/hooks/useCashRegisterOptions.ts', root), 'utf8')

  assert.doesNotMatch(options, /state\.sessions\.length === 1/)
  assert.doesNotMatch(options, /onSessionSelected/)
})
