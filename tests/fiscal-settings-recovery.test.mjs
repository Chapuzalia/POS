import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { compileComponent } from './helpers/component-harness.mjs'
import { UserFacingError } from '../src/utils/UserFacingError.ts'
import { isFiscalBridgeOrigin } from '../src/features/fiscal/local/bridgeUrl.ts'
import { readFiscalBackend } from '../src/features/fiscal/local/backendRead.ts'

const tenant = '11111111-1111-4111-8111-111111111111'
const settings = { tenant_id: tenant, bridge_url: null, aeat_environment: 'production', producer_name: 'Producer', producer_nif: 'B12345678', system_id: 'TK', system_version: '1' }
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')
function browser() {
  const window = new EventTarget()
  const cache = new Map()
  window.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) }
  window.setInterval = () => 1
  window.clearInterval = () => {}
  const document = new EventTarget()
  document.visibilityState = 'visible'
  return { window, document, CustomEvent, Event, URL }
}

test('recovery availability requires fresh settings even when an offline test configuration was cached', async () => {
  const globals = browser()
  globals.window.localStorage.setItem(`tickit:fiscal-pos-settings:v1:${tenant}`, JSON.stringify({ ...settings, aeat_environment: 'test' }))
  const query = { select() { return this }, eq() { return this }, abortSignal() { return this }, async maybeSingle() { return { error: new Error('unavailable') } } }
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), { './backendRead.ts': { readFiscalBackend }, zod:{z}, '../../../lib/supabase.ts': {supabase:{from:()=>query}}, '../../../utils/UserFacingError.ts': { UserFacingError }, './bridgeUrl.ts': { isFiscalBridgeOrigin } }, globals)
  assert.equal((await api.loadFiscalPosSettings(tenant)).aeat_environment,'test')
  await assert.rejects(api.loadFiscalPosSettings(tenant,false))
})
