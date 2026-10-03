import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { compileComponent, createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

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
  return { window, document, CustomEvent, Event }
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
    zod: { z }, '../../../lib/supabase.ts': { supabase: { from: table => { assert.equal(table,'fiscal_pos_bridge_settings'); return query } } },
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
  const query = { select() { return this }, eq() { return this }, async maybeSingle() { return { error: new Error('unavailable') } } }
  const api = compileComponent(source('../src/features/fiscal/local/settings.ts'), { zod:{z}, '../../../lib/supabase.ts': {supabase:{from:()=>query}} }, globals)
  assert.equal((await api.loadFiscalPosSettings(tenant)).aeat_environment,'test')
  await assert.rejects(api.loadFiscalPosSettings(tenant,false))
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
    './installation.ts': { loadFiscalInstallation: async()=>{throw new Missing()}, latestFiscalInstallation: async()=>({id:'installation',number:'MES-C1-1'}), FiscalActivationConfirmationError: class extends Error {} },
    './mode.ts': { localFiscalMode:()=> 'production' },
    './settings.ts': { FISCAL_SETTINGS_CHANGED:'tickit:fiscal-settings-changed', loadFiscalPosSettings:async(id,allowCached)=>{
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
