import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'

import { compileComponent } from './helpers/component-harness.mjs'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const tenantId = '11111111-1111-4111-8111-111111111111'
const otherTenantId = '22222222-2222-4222-8222-222222222222'
const settings = {
  tenant_id: tenantId, bridge_url: null, aeat_environment: 'production',
  producer_name: 'Productor SL', producer_nif: 'B12345678', system_id: 'TK', system_version: '1',
}
const source = readFileSync(new URL('../src/features/fiscal/local/settings.ts', import.meta.url), 'utf8')

function harness(row = settings) {
  const storage = new Map()
  const filters = []
  let unavailable = false
  let saved
  const supabase = {
    from(table) {
      assert.equal(table, 'fiscal_pos_bridge_settings')
      const query = {
        select() { return query },
        eq(column, value) { filters.push([column, value]); return query },
        upsert(value) { saved = value; return query },
        maybeSingle: async () => ({ data: row, error: unavailable ? new Error('Offline') : null }),
        single: async () => ({ data: saved, error: null }),
      }
      return query
    },
  }
  const service = compileComponent(source, { zod: { z }, '../../../lib/supabase.ts': { supabase } }, {
    URL,
    window: { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
  })
  return { service, storage, filters, goOffline: () => { unavailable = true }, getSaved: () => saved }
}

test('configuraciones anteriores y nulas mantienen el QR activado', async () => {
  for (const row of [settings, { ...settings, print_ticket_qr: null }]) {
    const { service, filters } = harness(row)
    assert.equal((await service.loadFiscalPosSettings(tenantId)).print_ticket_qr, true)
    assert.deepEqual(filters, [['tenant_id', tenantId]])
  }
})

test('la preferencia desactivada se guarda y sigue disponible sin conexión', async () => {
  const { service, goOffline, getSaved } = harness()
  const saved = await service.saveFiscalPosSettings({ ...settings, print_ticket_qr: false })
  assert.equal(saved.print_ticket_qr, false)
  assert.equal(getSaved().print_ticket_qr, false)
  assert.equal(getSaved().aeat_environment, 'production')
  goOffline()
  assert.equal((await service.loadFiscalPosSettings(tenantId)).print_ticket_qr, false)
})

test('la preferencia y su caché no se comparten entre tenants', async () => {
  const { service, goOffline } = harness({ ...settings, print_ticket_qr: false })
  await service.loadFiscalPosSettings(tenantId)
  await assert.rejects(service.loadFiscalPosSettings(otherTenantId), /otro tenant/)
  goOffline()
  await assert.rejects(service.loadFiscalPosSettings(otherTenantId), /copia local válida/)
  assert.equal((await service.loadFiscalPosSettings(tenantId)).print_ticket_qr, false)
})

test('la migración del checkbox es compatible y pasa el analizador de migraciones', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261003140000_add_ticket_qr_print_setting.sql', import.meta.url), 'utf8')
  assert.deepEqual(analyzeMigration(sql), [])
})
