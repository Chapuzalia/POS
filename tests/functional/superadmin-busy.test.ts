import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/components/superadmin/SuperAdminPage.tsx', import.meta.url), 'utf8')
const component = () => null

function harness() {
  const finishes: Array<(value: { tenants: []; features: [] }) => void> = []
  const load = vi.fn(() => new Promise<{ tenants: []; features: [] }>(resolve => { finishes.push(resolve) }))
  const onBusyChange = vi.fn()
  const icons = new Proxy({}, { get: () => component })
  const runner = createCompiledHookRunner(source, 'SuperAdminPage', {
    'react/jsx-runtime': jsxRuntime,
    '../ui/appDialogStore': { appConfirm: vi.fn() },
    '../../utils/notifications.ts': { notifyOperationalError: vi.fn() },
    '../ui/Input': { Input: component }, '../ui/Button': { Button: component }, '../ui/Checkbox': { Checkbox: component },
    '../ui/AppModal': { AppModal: component }, '../ui/DataTable': { DataTable: component },
    'lucide-react': icons,
    '../../services/platformService': { loadPlatformTenants: load },
    '../../utils/errors': { getReadableError: String },
    '../../features/platform/tenantFeatureAccess': { tenantAddonCatalog: [], updateTenantAddons: vi.fn() },
    '../../features/fiscal/local/integration': { loadPlatformVerifactuIntegrations: async () => [] },
    './VerifactuConfiguration': { VerifactuConfiguration: component },
    '../../features/billing/BillingSelectionEditor': { BillingSelectionEditor: component },
    '../../features/billing/service': { billingRequest: vi.fn() },
    '../../features/billing/selection': { emptyBillingSelection: { planVersionId: '', addons: [] }, generateOwnerPassword: vi.fn() },
  }, { window: { setInterval: () => 1, clearInterval() {} } })
  const props = { context: { userName: 'Admin' }, error: null, isOnline: true, onError: vi.fn(), onLogout: vi.fn(), onBusyChange }
  return { runner, props, onBusyChange, finish: (index = finishes.length - 1) => finishes[index]({ tenants: [], features: [] }) }
}

it('reports active work and releases the update block after completion and unmount', async () => {
  const h = harness()
  h.runner.render(h.props)
  h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(true)
  h.finish()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const tree = h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(false)
  nodes(tree).find(node => node.props?.['aria-label'] === 'Actualizar negocios')?.props.onClick()
  h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(true)
  h.runner.unmount()
  expect(h.onBusyChange).toHaveBeenLastCalledWith(false)
  h.finish()
})

it('keeps the update block while its billing child reports active work', async () => {
  const h = harness()
  h.runner.render(h.props)
  h.finish()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  let tree = h.runner.render(h.props)
  const billingButton = nodes(tree).find(node => node.props?.onClick && nodes(node.props.children).some(child => child.props?.children === 'Facturación'))
  expect(billingButton).toBeDefined()
  billingButton?.props.onClick()
  tree = h.runner.render(h.props)
  const billing = nodes(tree).find(node => typeof node.props?.onBusyChange === 'function')
  expect(billing).toBeDefined()
  billing?.props.onBusyChange(true)
  tree = h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(true)
  const tenantsButton = nodes(tree).find(node => node.props?.onClick && nodes(node.props.children).some(child => child.props?.children === 'Negocios'))
  expect(tenantsButton?.props.disabled).toBe(true)
  billing?.props.onBusyChange(false)
  h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(false)
  h.runner.unmount()
})

it('does not release an earlier operation when a reconnection refresh finishes first', async () => {
  const h = harness()
  h.runner.render(h.props)
  h.runner.render({ ...h.props, isOnline: false })
  h.runner.render(h.props)
  h.finish(1)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(true)
  h.finish(0)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  h.runner.render(h.props)
  expect(h.onBusyChange).toHaveBeenLastCalledWith(false)
  h.runner.unmount()
})
