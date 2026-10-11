import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { compileComponent, createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'
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

test('AEAT switch saves only its environment scoped by tenant and notifies an already open popup', async () => {
  const globals = browser()
  let update, scope, changed
  globals.window.addEventListener('tickit:fiscal-settings-changed', event => { changed = event.detail })
  const query = {
    update(value) { update = value; return this },
    eq(column, value) { scope = [column,value]; return this },
    select() { return this },
    async single() { return { data: { ...settings, ...update }, error: null } },
  }
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), {
    './backendRead.ts': { readFiscalBackend },
    zod: { z }, '../../../lib/supabase.ts': { supabase: { from: table => { assert.equal(table,'fiscal_pos_bridge_settings'); return query } } },
    '../../../utils/UserFacingError.ts': { UserFacingError },
    './bridgeUrl.ts': { isFiscalBridgeOrigin },
  }, globals)
  const saved = await api.saveFiscalAeatEnvironment(tenant, 'test')
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { aeat_environment: 'test' })
  assert.deepEqual(scope, ['tenant_id',tenant])
  assert.equal(saved.aeat_environment, 'test')
  assert.equal(changed, tenant)
  assert.equal(JSON.parse(globals.window.localStorage.getItem(`tickit:fiscal-pos-settings:v1:${tenant}`)).aeat_environment, 'test')
})

test('recovery availability requires fresh settings even when an offline test configuration was cached', async () => {
  const globals = browser()
  globals.window.localStorage.setItem(`tickit:fiscal-pos-settings:v1:${tenant}`, JSON.stringify({ ...settings, aeat_environment: 'test' }))
  const query = { select() { return this }, eq() { return this }, abortSignal() { return this }, async maybeSingle() { return { error: new Error('unavailable') } } }
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), { './backendRead.ts': { readFiscalBackend }, zod:{z}, '../../../lib/supabase.ts': {supabase:{from:()=>query}}, '../../../utils/UserFacingError.ts': { UserFacingError }, './bridgeUrl.ts': { isFiscalBridgeOrigin } }, globals)
  assert.equal((await api.loadFiscalPosSettings(tenant)).aeat_environment,'test')
  await assert.rejects(api.loadFiscalPosSettings(tenant,false))
})

test('saving fiscal settings identifies the invalid field before sending any database request', async () => {
  let requests = 0
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), {
    './backendRead.ts': { readFiscalBackend },
    zod: { z }, '../../../lib/supabase.ts': { supabase: { from() { requests++; throw new Error('must not reach database') } } },
    '../../../utils/UserFacingError.ts': { UserFacingError },
    './bridgeUrl.ts': { isFiscalBridgeOrigin },
  }, browser())
  for (const url of ['http://localhost.evil:3000/', 'http://fiscal.example/', 'http://localhost:3000/admin', 'http://user:password@localhost:3000/', 'http://localhost:3000/?a=1', 'https://fiscal.example/admin/', 'https://user:password@fiscal.example/', 'fiscal.example']) {
    await assert.rejects(api.saveFiscalPosSettings({ ...settings, bridge_url: url }), error => error instanceof UserFacingError && /URL del puente:.*HTTPS/.test(error.message))
  }
  await assert.rejects(api.saveFiscalPosSettings({ ...settings, system_id: 'T' }), error => error instanceof UserFacingError && /ID de sistema:.*2/.test(error.message))
  await assert.rejects(api.saveFiscalPosSettings({ ...settings, producer_nif: 'B123' }), error => error instanceof UserFacingError && /NIF del productor:.*9/.test(error.message))
  assert.equal(requests, 0)
})

test('saving HTTPS, local HTTP and local-only settings preserves the tenant scope and stored URL', async () => {
  let payload, table
  const query = {
    upsert(value, options) { payload = value; assert.equal(options.onConflict, 'tenant_id'); return this },
    select() { return this }, async single() { return { data: payload, error: null } },
  }
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), {
    './backendRead.ts': { readFiscalBackend },
    zod: { z }, '../../../lib/supabase.ts': { supabase: { from(value) { table=value; return query } } },
    '../../../utils/UserFacingError.ts': { UserFacingError },
    './bridgeUrl.ts': { isFiscalBridgeOrigin },
  }, browser())
  for (const url of ['https://fiscal.example/', 'https://fiscal.example:8443/', 'http://localhost:3000/', 'http://localhost:3000', 'http://127.0.0.1:3000/', 'http://[::1]:3000/', '']) {
    const saved = await api.saveFiscalPosSettings({ ...settings, bridge_url: url })
    assert.equal(saved.bridge_url, url)
    assert.equal(payload.bridge_url, url || null)
    assert.equal(payload.tenant_id, tenant)
    assert.equal(table, 'fiscal_pos_bridge_settings')
  }
})

test('missing-identity popup refreshes on CRM changes and shows/hides recovery using saved environment', async () => {
  const globals = browser()
  class Missing extends Error {}
  let environment = 'production'
  const runner = createCompiledHookRunner(source('../src/features/fiscal/local/FiscalInstallationGate.tsx'), 'FiscalInstallationGate', {
    'react/jsx-runtime': jsxRuntime,
    '../../../components/ui/AppModal': { AppModal: 'modal' },
    '../../../components/ui/Button': { Button: 'button' },
    '../../../utils/errors': { getReadableError: error => error.message },
    './localIdentity.ts': { FiscalIdentityMissingError: Missing },
    './installationRevocation.ts': { FISCAL_INSTALLATION_REVOKED: 'installation-revoked', checkFiscalInstallationRevocation: async () => {} },
    './installation.ts': { loadFiscalInstallation: async()=>{throw new Missing()}, latestFiscalInstallation: async()=>({id:'installation',number:'MES-C1-1'}), FiscalActivationConfirmationError: class extends Error {} },
    './tenantMode.ts': { resolveLocalFiscalMode:async()=> 'production' },
    './settings.ts': { FISCAL_SETTINGS_CHANGED:'tickit:fiscal-settings-changed' },
    './integration.ts': { loadVerifactuIntegration:async(id,allowCached)=>{
      assert.equal(id,tenant); assert.equal(allowCached,false); return {aeat_environment:environment}
    } },
  }, globals)
  const props = {context:{tenantId:tenant},cashSession:{id:'cash'},onLogout:async()=>{},children:'POS'}
  const settle = async()=>{ runner.render(props); await new Promise(setImmediate); return runner.render(props) }
  const recovery = tree=>nodes(tree).some(node=>node.type==='button' && String(node.props.children).includes('Recuperar última'))
  assert.equal(recovery(await settle()),false)
  environment='test'
  globals.window.dispatchEvent(new CustomEvent('tickit:fiscal-settings-changed',{detail:tenant}))
  assert.equal(recovery(await settle()),true)
  environment='production'
  globals.window.dispatchEvent(new Event('focus'))
  assert.equal(recovery(await settle()),false)
  runner.unmount()
})
