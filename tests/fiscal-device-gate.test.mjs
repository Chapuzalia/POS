import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const settle = () => new Promise(setImmediate)
const context = mode => ({ tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user', deviceMode: mode })
const cashSession = { id: 'cash', cashRegisterId: 'register' }
class MissingIdentity extends Error {}

function gate(mode, failure, revocation = { active: false }) {
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
      fiscalIdentityKey: () => 'identity-key',
    },
    './installationRevocation.ts': { FISCAL_INSTALLATION_REVOKED: 'installation-revoked', checkFiscalInstallationRevocation: async () => { if (revocation.active) throw Object.assign(new MissingIdentity(), { installationRevoked: true }) } },
    './tenantMode.ts': { resolveLocalFiscalMode: () => { calls.push('mode'); return Promise.resolve('production') } },
    './integration.ts': { loadVerifactuIntegration: async () => { calls.push('settings'); return { aeat_environment: 'production' } } },
    './settings.ts': {
      FISCAL_SETTINGS_CHANGED: 'fiscal-settings-changed',
      loadFiscalPosSettings: async () => { calls.push('settings'); return { aeat_environment: 'production' } },
    },
  }, { window, document, Event, CustomEvent })
  const props = { context: context(mode), cashSession, children: 'POS', onLogout: async () => {}, onBusyChange: value => busy.push(value) }
  return { runner, props, calls, busy, window, document }
}

// Missing modes keep the existing gate for older cached contexts.
for (const mode of ['checkout', 'hybrid', undefined]) {
  test(`${mode ?? 'legacy'} blocks entry until its fiscal installation is validated`, async () => {
    const { runner, props, calls } = gate(mode)
    assert.equal(runner.render(props).type, 'modal')
    await settle()
    assert.equal(runner.render(props), 'POS')
    assert.deepEqual(calls, ['mode', 'load', 'timer'])
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

test('a running checkout detects revocation without reloading and permits only a new installation', async () => {
  const revoked = { active: false }
  const { runner, props, window } = gate('checkout', undefined, revoked)
  runner.render(props); await settle()
  assert.equal(runner.render(props), 'POS')
  revoked.active = true
  window.dispatchEvent(new Event('online'))
  await settle()
  const tree = runner.render(props)
  assert.equal(tree.type, 'modal')
  assert.ok(nodes(tree).some(node => typeof node.props?.children === 'string' && node.props.children.includes('revocada desde el bridge')))
  assert.ok(nodes(tree).some(node => node.props?.children === 'Crear nueva instalación' && !node.props.disabled))
  assert.ok(!nodes(tree).some(node => String(node.props?.children).includes('Recuperar última')))
  runner.unmount()
})
