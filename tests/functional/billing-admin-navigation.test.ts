import { readFileSync } from 'node:fs'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import * as presentation from '../../src/features/billing/presentation'

const text = (node: ReturnType<typeof nodes>[number]): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.props ? text(node.props.children) : ''
function setup() {
  const accounts = [
    { tenant_id: 'active', name: 'Cliente al día', status: 'active', last_payment_status: 'paid' },
    { tenant_id: 'debt', name: 'Cliente con deuda', status: 'past_due', last_payment_status: 'open' },
    { tenant_id: 'sepa', name: 'Cliente SEPA', status: 'active', last_payment_status: 'processing' },
  ]
  const request = vi.fn(async ({ action }: { action: string }) => {
    if (action === 'overview') return { accounts, events: [], metrics: {}, truncated: false }
    if (action === 'catalog') return { products: [], versions: [] }
    if (action === 'reconcile-batch') return { results: [{ ok: true }, { ok: false }] }
    return {}
  })
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/billing/BillingAdmin.tsx', import.meta.url), 'utf8'), 'default', {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Button': { Button: 'button' }, '../../components/ui/DataTable': { DataTable: 'table' }, '../../components/ui/Input': { Input: 'input' },
    './BillingCatalogEditor': { BillingCatalogEditor: 'catalog' },
    './TenantBillingPanel': { TenantBillingPanel: 'billing-panel', billingCard: '', billingField: '' },
    './service': { billingRequest: request, billingDate: String, billingMoney: String }, './presentation': presentation,
  }, { Date })
  const render = () => runner.render({ disabled: false })
  const button = (label: string) => nodes(render()).find(node => node.type === 'button' && text(node).includes(label))
  onTestFinished(() => runner.unmount())
  return { render, button, request }
}

it('starts with clients, filters only actionable accounts, clears empty searches and opens the selected client', async () => {
  const h = setup()
  h.render()
  await vi.waitFor(() => expect(text(h.render())).toContain('Cliente con deuda'))
  expect(h.button('Clientes').props['aria-pressed']).toBe(true)
  h.button('Necesitan atención').props.onClick()
  expect(text(h.render())).toContain('Cliente con deuda')
  expect(text(h.render())).not.toContain('Cliente SEPA')
  expect(text(h.render())).not.toContain('Cliente al día')
  const search = nodes(h.render()).find(node => node.props?.['aria-label'] === 'Buscar empresa o NIF')
  search.props.onChange({ target: { value: 'No existe' } })
  expect(text(h.render())).toContain('No hay clientes con estos filtros')
  h.button('Limpiar filtros').props.onClick()
  expect(text(h.render())).toContain('Cliente SEPA')
  nodes(h.render()).find(node => node.props?.['aria-label'] === 'Gestionar Cliente con deuda').props.onClick()
  expect(nodes(h.render()).find(node => node.type === 'billing-panel').props).toMatchObject({ tenantId: 'debt', admin: true })
})

it('reports partial failures from batch reconciliation instead of implying everything succeeded', async () => {
  const h = setup()
  h.render()
  await vi.waitFor(() => expect(text(h.render())).toContain('Cliente con deuda'))
  h.button('Diagnóstico').props.onClick()
  h.button('Actualizar estados con Stripe').props.onClick()
  await vi.waitFor(() => expect(text(h.render())).toContain('1 no se han podido comprobar'))
  expect(text(h.render())).toContain('1 cuentas actualizadas')
})
