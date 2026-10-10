import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const settle = () => new Promise(setImmediate)
const context = mode => ({ tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user', deviceMode: mode })
const cashSession = { id: 'cash', cashRegisterId: 'register' }
class MissingIdentity extends Error {}

function gate(mode, failure) {
  const calls = []
  const busy = []
  const window = new EventTarget()
  window.setInterval = () => { calls.push('timer'); return 1 }
  window.clearInterval = () => {}
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const runner = createCompiledHookRunner(source('../src/features/fiscal/local/FiscalInstallationGate.tsx'), 'FiscalInstallationGate', {
    'react/jsx-runtime': jsxRuntime,
    '../../../components/ui/AppModal': { AppModal: 'modal' },
    '../../../components/ui/Button': { Button: 'button' },
    '../../../utils/errors': { getReadableError: error => error.message },
    './localIdentity.ts': { FiscalIdentityMissingError: MissingIdentity },
    './installation.ts': {
      loadFiscalInstallation: async () => { calls.push('load'); if (failure) throw failure },
      latestFiscalInstallation: async () => { calls.push('preview'); return null },
      activateFiscalInstallation: async () => { calls.push('activate') },
      FiscalActivationConfirmationError: class extends Error {},
    },
    './mode.ts': { localFiscalMode: () => { calls.push('mode'); return 'production' } },
    './settings.ts': {
      FISCAL_SETTINGS_CHANGED: 'fiscal-settings-changed',
      loadFiscalPosSettings: async () => { calls.push('settings'); return { aeat_environment: 'production' } },
    },
  }, { window, document, Event, CustomEvent })
  const props = { context: context(mode), cashSession, children: 'POS', onLogout: async () => {}, onBusyChange: value => busy.push(value) }
  return { runner, props, calls, busy, window, document }
}

for (const failure of [undefined, new MissingIdentity(), new Error('ledger incompleto')]) {
  test(`satellite enters an open checkout without fiscal reads or activation (${failure?.constructor.name ?? 'valid'})`, async () => {
    const { runner, props, calls, busy, window, document } = gate('satellite', failure)
    assert.equal(runner.render(props), 'POS')
    await settle()
    assert.equal(runner.render(props), 'POS')
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('storage'))
    window.dispatchEvent(new CustomEvent('fiscal-settings-changed', { detail: 'tenant' }))
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    assert.equal(runner.render(props), 'POS')
    assert.deepEqual(calls, [])
    assert.ok(busy.every(value => value === false))
    runner.unmount()
  })
}

// Missing modes keep the existing gate for older cached contexts.
for (const mode of ['checkout', 'hybrid', undefined]) {
  test(`${mode ?? 'legacy'} blocks entry until its fiscal installation is validated`, async () => {
    const { runner, props, calls } = gate(mode)
    assert.equal(runner.render(props).type, 'modal')
    await settle()
    assert.equal(runner.render(props), 'POS')
    assert.deepEqual(calls, ['mode', 'load'])
    runner.unmount()
  })

  test(`${mode ?? 'legacy'} requires activation when its fiscal identity is missing`, async () => {
    const { runner, props, calls } = gate(mode, new MissingIdentity())
    runner.render(props)
    await settle()
    const tree = runner.render(props)
    assert.equal(tree.type, 'modal')
    const activate = nodes(tree).find(node => node.type === 'button' && node.props.children === 'Crear nueva instalación')
    assert.ok(activate)
    assert.equal(activate.props.disabled, false)
    activate.props.onClick()
    await settle()
    assert.equal(runner.render(props), 'POS')
    assert.ok(calls.includes('load') && calls.includes('preview') && calls.includes('settings') && calls.includes('activate'))
    runner.unmount()
  })

  test(`${mode ?? 'legacy'} remains blocked for a failed ledger and cannot create a replacement`, async () => {
    const { runner, props, calls } = gate(mode, new Error('ledger incompleto'))
    runner.render(props)
    await settle()
    const tree = runner.render(props)
    assert.equal(tree.type, 'modal')
    assert.ok(nodes(tree).some(node => node.props?.role === 'alert' && node.props.children === 'ledger incompleto'))
    assert.deepEqual(calls, ['mode', 'load'])
    runner.unmount()
  })
}

test('a mode change cancels an in-flight checkout check before a satellite renders', async () => {
  const { runner, props, calls } = gate('checkout', new MissingIdentity())
  runner.render(props)
  const satellite = { ...props, context: context('satellite') }
  assert.equal(runner.render(satellite), 'POS')
  await settle()
  assert.equal(runner.render(satellite), 'POS')
  assert.deepEqual(calls, ['mode', 'load'])
  runner.unmount()
})

test('satellites still synchronize durable records from historical installations without an emission identity', async () => {
  const calls = []
  const scopes = [{ installationId: 'retired-installation' }]
  const window = new EventTarget()
  window.setInterval = () => 1
  window.clearInterval = () => {}
  const runner = createCompiledHookRunner(source('../src/features/fiscal/local/FiscalQueueNotice.tsx'), 'FiscalQueueNotice', {
    './economicSync.ts': { startFiscalEconomicSyncWhileOpen: scope => { calls.push(['economic', scope]); return () => calls.push(['stop-economic']) } },
    './installation.ts': { fiscalBridgeAccessToken: async () => 'token' },
    './localLedger.ts': { listLocalFiscalScopes: async (ctx, register) => { assert.equal(ctx.deviceMode, 'satellite'); assert.equal(register, 'register'); return scopes } },
    './mode.ts': { localFiscalMode: () => 'production' },
    './settings.ts': {
      loadFiscalPosSettings: async () => ({ bridge_url: 'https://bridge.example' }),
      subscribeFiscalPosSettings: () => () => {},
    },
    './sync.ts': { startFiscalSyncWhileOpen: scope => { calls.push(['bridge', scope.installationId]); return () => calls.push(['stop-bridge']) } },
  }, { window, document: new EventTarget() })
  runner.render({ context: context('satellite'), cashSession })
  await settle()
  assert.deepEqual(calls, [['economic', scopes[0]], ['bridge', 'retired-installation']])
  runner.unmount()
  assert.deepEqual(calls.slice(2), [['stop-economic'], ['stop-bridge']])
})
