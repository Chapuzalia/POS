import { readFileSync } from 'node:fs'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import { centsToInput, parseMoneyToCents, formatMoney } from '../../src/lib/format'
import { billingFailureDiagnostic } from '../../supabase/functions/_shared/billing/diagnostics'
import { MollieRequestError } from '../../supabase/functions/_shared/billing/mollie'
import * as presentation from '../../src/features/billing/presentation'
import type { BillingInvoice } from '../../src/features/billing/types'

const product = { key: 'base', kind: 'plan', name: 'Base', description: '', scope: 'tenant', featureKey: null, resource: null, active: true, sortOrder: 0 }
const addon = { ...product, key: 'personal', kind: 'addon', name: 'Personal' }
const version = { id: 'plan', productKey: 'base', interval: 'month', amountCents: 4900, features: [], limits: { venues: 1, devices: 2 }, included: {}, maximum: null, requires: [], published: true, stripePriceId: 'price_base' }
const addonVersion = { ...version, id: 'addon', productKey: 'personal', amountCents: 500 }
const catalog = { products: [product, addon], versions: [version, addonVersion, { ...version, id: 'old-plan', amountCents: 3900 }], features: [] }
const selection = { planVersionId: 'plan', addons: [{ key: 'personal', versionId: 'addon', quantity: 1, venueIds: [], deviceIds: [] }] }
const contract = { planName: 'Base', recurringCents: 5400, interval: 'month', selection, addons: [], exception: null, limits: { venues: 1, devices: 2 } }
const primitives = {
  'react/jsx-runtime': jsxRuntime,
  '../../components/ui/Button': { Button: 'button' },
  '../../components/ui/Input': { Input: 'input' },
  '../../components/ui/Checkbox': { Checkbox: 'checkbox' },
  '../../components/ui/DataTable': { DataTable: 'table' },
}
function text(node: ReturnType<typeof nodes>[number]): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return node?.props ? text(node.props.children) : ''
}
const button = (tree: object, label: string) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))
const input = (tree: object, label: string) => nodes(nodes(tree).find(node => node.type === 'label' && text(node).includes(label))).find(node => node.type === 'input')

function panel(active = false, temporary = false, pending = false, admin = true) {
  const agreement = { ...contract, exception: temporary ? { freeUnits: {}, limits: {}, discountBasisPoints: 1000, customAmounts: {}, cycles: 3, reason: 'Descuento temporal' } : null }
  const detail = {
    account: { status: active ? 'active' : 'manual', stripe_customer_id: active ? 'cst_test' : null, stripe_subscription_id: active ? 'sub_test' : null, contract: active ? agreement : null, onboarding_contract: agreement },
    tenant: { id: 'tenant', name: 'Empresa', max_venues: 1, max_devices: 2 },
    venues: [{ id: 'venue', name: 'Centro' }], devices: [], operations: pending ? [{ id: 'pending', status: 'scheduled', reason: 'Añadir personal en Centro', effective_at: '2026-12-03', contract: { ...contract, recurringCents: 5900, limits: { venues: 2, devices: 4 }, addons: [{ key: 'personal', quantity: 2, included: 0, billable: 2, scope: 'venue', venueIds: ['venue'], deviceIds: [] }] } }] : [], audit: [], invoices: [] as BillingInvoice[],
  }
  const confirm = vi.fn<() => Promise<{ url?: string }>>(async () => { throw new Error('No se pudo confirmar. Revisa el estado antes de reintentar.') })
  const openUrl = vi.fn()
  const request = vi.fn(async ({ action }: { action: string }) => {
    if (action === 'catalog') return catalog
    if (action === 'get') return detail
    if (action === 'quote') return { id: 'quote', kind: 'change', timing: 'immediate', preview: { amountDueCents: 6534, recurringCents: 5400 } }
    if (action === 'portal') return { url: 'https://www.mollie.com/checkout/arrears' }
    if (action === 'confirm') return confirm()
    throw new Error('No se pudo confirmar. Revisa el estado antes de reintentar.')
  })
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/billing/TenantBillingPanel.tsx', import.meta.url), 'utf8'), 'TenantBillingPanel', {
    ...primitives,
    '../../components/ui/AppModal': { AppModal: 'dialog' },
    '../../lib/format': { parseMoneyToCents },
    './presentation': presentation,
    './service': { billingRequest: request, billingMoney: formatMoney, billingDate: String, openBillingUrl: openUrl },
  }, { Error, Date, crypto })
  const render = () => runner.render({ tenantId: 'tenant', admin })
  const exceptionTree = () => {
    const editor = nodes(render()).find(node => typeof node.type === 'function' && node.type.name === 'ExceptionEditor')
    return editor.type(editor.props)
  }
  onTestFinished(() => runner.unmount())
  return { render, request, exceptionTree, detail, confirm, openUrl }
}

it('keeps the customer plan minimal until Modify plan is opened and retains the existing quote flow', async () => {
  const h = panel(true, false, true, false)
  const agreement = h.detail.operations[0].contract
  h.detail.account.contract = agreement
  h.detail.operations = []
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Modificar plan')).toBeDefined())
  const overview = text(h.render())
  expect(overview).toContain('Mi plan')
  expect(overview).toContain('Base')
  expect(overview).toContain(formatMoney(5900))
  expect(overview).toContain('Personal')
  expect(overview.replace(/\s+/g, ' ')).toContain('2 unidades')
  expect(overview).toContain('Facturas de suscripción')
  for (const label of ['Plan y tarifa', 'Último pago', 'Historial de cambios', 'Actualizar ficha']) expect(overview).not.toContain(label)
  expect(button(h.render(), 'Revisar cambio')).toBeUndefined()
  expect(h.request.mock.calls.some(([body]) => ['quote', 'confirm', 'portal'].includes(body.action))).toBe(false)
  expect(button(h.render(), 'Pagar cuota pendiente')).toBeUndefined()
  // Mollie has no payment-method portal: the owner pays a failed or returned charge by card.
  h.detail.account.status = 'past_due'
  await button(h.render(), 'Pagar cuota pendiente').props.onClick()
  await vi.waitFor(() => expect(h.request.mock.calls.some(([body]) => body.action === 'portal')).toBe(true))
  button(h.render(), 'Modificar plan').props.onClick()
  expect(text(h.render())).toContain('Plan y tarifa')
  expect(nodes(h.render()).some(node => typeof node.type === 'function' && node.type.name === 'ExceptionEditor')).toBe(false)
  expect(nodes(h.render()).some(node => node.type === 'section' && node.props.id === 'billing-plan-editor-tenant')).toBe(true)
  expect(nodes(h.render()).some(node => node.props?.['aria-label'] === 'Resumen del plan')).toBe(false)
  button(h.render(), 'Revisar cambio').props.onClick()
  await vi.waitFor(() => expect(button(h.render(), 'Confirmar cambio')).toBeDefined())
  expect(h.request.mock.calls.find(([body]) => body.action === 'quote')[0]).toMatchObject({ tenantId: 'tenant', exception: null })
  const dialog = nodes(h.render()).find(node => node.type === 'dialog')
  nodes(dialog).find(node => node.type === 'button' && text(node) === 'Volver').props.onClick()
  button(h.render(), 'Volver a mi plan').props.onClick()
  expect(button(h.render(), 'Revisar cambio')).toBeUndefined()
  expect(h.request.mock.calls.some(([body]) => body.action === 'confirm')).toBe(false)
})

it('keeps customer pending payments visible while plan modifications remain blocked', async () => {
  const h = panel(true, false, true, false)
  h.detail.operations[0].status = 'payment_pending'
  Object.assign(h.detail.operations[0], { result: { url: 'https://www.mollie.com/checkout/invoice' } })
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Modificar plan')).toBeDefined())
  expect(text(h.render())).toContain('Completar el pago pendiente')
  expect(button(h.render(), 'Continuar pago')).toBeDefined()
  expect(button(h.render(), 'Revisar cambio')).toBeUndefined()
  button(h.render(), 'Modificar plan').props.onClick()
  expect(button(h.render(), 'Revisar cambio').props.disabled).toBe(true)
  expect(button(h.render(), 'Continuar pago')).toBeDefined()
})

it('keeps plan configuration in superadmin without opening payment pages, including older backend responses', async () => {
  const h = panel()
  h.confirm.mockResolvedValue({ url: 'https://www.mollie.com/checkout/test' })
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  expect(button(h.render(), 'Métodos de pago')).toBeUndefined()
  button(h.render(), 'Ver importes').props.onClick()
  await vi.waitFor(() => expect(button(h.render(), 'Confirmar cambio')).toBeDefined())
  button(h.render(), 'Confirmar cambio').props.onClick()
  await vi.waitFor(() => expect(text(h.render())).toContain('Plan configurado. El cliente debe completar el pago desde su cuenta'))
  expect(h.openUrl).not.toHaveBeenCalled()
  expect(h.request.mock.calls.some(([body]) => body.action === 'portal')).toBe(false)
})

it.each([true, false])('reserves pending payment and invoice links for the customer (admin=%s)', async admin => {
  const h = panel(true, false, true, admin)
  h.detail.operations[0].status = 'payment_pending'
  Object.assign(h.detail.operations[0], { result: { url: 'https://www.mollie.com/checkout/test' } })
  h.detail.invoices.push({ stripe_invoice_id: 'in_test', number: 'INV-1', status: 'open', amount_due_cents: 6534, amount_paid_cents: 0, created_at: '2026-11-04', hosted_invoice_url: 'https://www.mollie.com/checkout/invoice', invoice_pdf: null })
  h.render()
  await vi.waitFor(() => expect(text(h.render())).toContain('Base'))
  const link = nodes(h.render()).find(node => node.type === 'a' && text(node) === 'Abrir factura')
  expect(Boolean(link)).toBe(!admin)
  expect(Boolean(button(h.render(), 'Continuar pago'))).toBe(!admin)
  h.detail.account.status = 'past_due'
  expect(Boolean(button(h.render(), 'Pagar cuota pendiente'))).toBe(!admin)
  h.detail.account.status = 'active'
  if (admin) {
    expect(text(h.render())).toContain('El cliente debe completar el pago desde su cuenta')
    expect(text(h.render())).not.toContain('Facturas de suscripción')
    expect(text(h.render())).not.toContain('INV-1')
  } else {
    expect(text(h.render())).toContain('INV-1')
    expect(link.props.href).toBe('https://www.mollie.com/checkout/invoice')
  }
})

it('discards an unconfirmed customer draft when returning to the plan overview', async () => {
  const h = panel(true, false, false, false)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Modificar plan')).toBeDefined())
  button(h.render(), 'Modificar plan').props.onClick()
  const toggle = () => nodes(h.render()).find(node => node.type === 'checkbox' && node.props['aria-label'] === 'Personal')
  expect(toggle().props.checked).toBe(true)
  toggle().props.onChange(false)
  expect(toggle().props.checked).toBe(false)
  button(h.render(), 'Volver a mi plan').props.onClick()
  button(h.render(), 'Modificar plan').props.onClick()
  expect(toggle().props.checked).toBe(true)
  expect(h.request.mock.calls.some(([body]) => ['quote', 'confirm'].includes(body.action))).toBe(false)
})

it('prevents promotions and temporary cycles before activation while allowing a permanent discount', async () => {
  const h = panel()
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  nodes(h.exceptionTree()).find(node => node.type === 'checkbox').props.onChange(true)
  let editor = h.exceptionTree()
  expect(input(editor, 'Justificación').props.value).toBe('Cambio solicitado por el cliente')
  expect(input(editor, 'Ciclos completos').props.disabled).toBe(true)
  const promotion = nodes(editor).find(node => node.type === 'checkbox' && text(node) === 'Personal')
  expect(promotion.props.disabled).toBe(true)
  expect(text(editor)).toContain('Activa primero la suscripción')
  input(editor, 'Descuento (%)').props.onChange({ target: { value: '10' } })
  expect(button(h.render(), 'Ver importes').props.disabled).toBe(false)
  editor = h.exceptionTree()
  input(editor, 'Justificación').props.onChange({ target: { value: ' ' } })
  expect(button(h.render(), 'Ver importes').props.disabled).toBe(true)
  expect(text(h.render())).toContain('Indica la justificación')
  expect(h.request.mock.calls.some(([body]) => body.action === 'quote')).toBe(false)
})

it('requires consent for promotions on active subscriptions and prevents combining them with temporary cycles', async () => {
  const h = panel(true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  nodes(h.exceptionTree()).find(node => node.type === 'checkbox').props.onChange(true)
  const promotion = nodes(h.exceptionTree()).find(node => node.type === 'checkbox' && text(node) === 'Personal')
  expect(promotion.props.disabled).toBe(false)
  promotion.props.onChange(true)
  expect(button(h.render(), 'Ver importes').props.disabled).toBe(true)
  expect(input(h.exceptionTree(), 'Ciclos completos').props.disabled).toBe(true)
  input(h.exceptionTree(), 'Consentimiento del cliente').props.onChange({ target: { value: 'Acuerdo aceptado por email el 3 de noviembre' } })
  expect(button(h.render(), 'Ver importes').props.disabled).toBe(false)
})

it('explains an existing temporary discount and does not offer a conflicting addon promotion', async () => {
  const h = panel(true, true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  const editor = h.exceptionTree()
  expect(nodes(editor).find(node => node.type === 'checkbox' && text(node) === 'Personal').props.disabled).toBe(true)
  expect(text(editor)).toContain('El contrato tiene un descuento temporal por ciclos')
})

it('explains a pending scheduled change before another quote can be requested', async () => {
  const h = panel(true, false, true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  expect(button(h.render(), 'Ver importes').props.disabled).toBe(true)
  expect(text(h.render())).toContain('Hay un cambio programado para la próxima renovación')
  const notice = nodes(h.render()).find(node => node.props?.['aria-label'] === 'Siguiente paso')
  expect(text(notice)).toContain('2026-12-03')
  const current = nodes(notice).find(node => node.type === 'div' && text(node).startsWith('Contrato actual'))
  const scheduled = nodes(notice).find(node => node.type === 'div' && text(node).startsWith('Contrato programado'))
  expect(text(current)).toContain(formatMoney(5400))
  expect(text(current)).toContain('Sin complementos adicionales')
  expect(text(scheduled)).toContain(formatMoney(5900))
  expect(text(scheduled).replace(/\s+/g, ' ')).toContain('Hasta 2 locales y 4 dispositivos')
  expect(text(scheduled).replace(/\s+/g, ' ')).toContain('Personal : 2')
  expect(text(scheduled)).toContain('Centro')
  expect(text(notice)).toContain('Añadir personal en Centro')
})

it('shows confirmation failures inside the review dialog and discards a quote when its reason changes', async () => {
  const h = panel(true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  button(h.render(), 'Ver importes').props.onClick()
  await vi.waitFor(() => expect(button(h.render(), 'Confirmar cambio')).toBeDefined())
  button(h.render(), 'Confirmar cambio').props.onClick()
  await vi.waitFor(() => {
    const dialog = nodes(h.render()).find(node => node.type === 'dialog')
    expect(nodes(dialog).some(node => node.props?.role === 'alert' && text(node).includes('No se pudo confirmar'))).toBe(true)
  })
  button(h.render(), 'Volver').props.onClick()
  button(h.render(), 'Ver importes').props.onClick()
  await vi.waitFor(() => expect(button(h.render(), 'Confirmar cambio')).toBeDefined())
  input(h.render(), 'Motivo').props.onChange({ target: { value: 'Otro acuerdo' } })
  expect(nodes(h.render()).some(node => node.type === 'dialog')).toBe(false)
})

it('keeps historical tariffs out of the normal plan picker until explicitly requested', async () => {
  const h = panel(true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  const options = () => nodes(h.render()).filter(node => node.type === 'option').map(node => node.props.value)
  expect(options()).not.toContain('old-plan')
  nodes(h.render()).find(node => node.type === 'checkbox' && text(node) === 'Mostrar tarifas anteriores').props.onChange(true)
  expect(options()).toContain('old-plan')
})

it('edits a particular price in euros while sending integer cents', async () => {
  const h = panel(true)
  h.render()
  await vi.waitFor(() => expect(button(h.render(), 'Ver importes')).toBeDefined())
  nodes(h.exceptionTree()).find(node => node.type === 'checkbox').props.onChange(true)
  input(h.exceptionTree(), 'Precio particular sin IVA').props.onChange({ target: { value: '5.25' } })
  button(h.render(), 'Ver importes').props.onClick()
  await vi.waitFor(() => expect(h.request.mock.calls.some(([body]) => body.action === 'quote')).toBe(true))
  expect(h.request.mock.calls.find(([body]) => body.action === 'quote')[0].exception.customAmounts.base).toBe(525)
})

function editorHarness(existing = false) {
  const request = vi.fn(async () => ({}))
  const onSaved = vi.fn(async () => {})
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/billing/BillingCatalogEditor.tsx', import.meta.url), 'utf8'), 'BillingCatalogEditor', {
    ...primitives,
    './TenantBillingPanel': { billingField: '', billingCard: '' },
    '../../lib/format': { centsToInput, parseMoneyToCents },
    './service': { billingMoney: formatMoney, billingRequest: request },
  }, { Error })
  const render = () => runner.render({ catalog: existing ? catalog : { products: [], versions: [], features: [] }, onSaved })
  const submit = () => nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  onTestFinished(() => runner.unmount())
  return { render, submit, request, onSaved }
}

it.each(['5', '5,25', '5.25'])('saves %s euros as integer cents and avoids duplicate tariffs on rapid or repeated submission', async price => {
  const h = editorHarness()
  input(h.render(), 'Identificador').props.onChange({ target: { value: 'new_plan' } })
  input(h.render(), 'Nombre').props.onChange({ target: { value: 'Nuevo plan' } })
  input(h.render(), 'Precio sin impuestos').props.onChange({ target: { value: price } })
  h.submit(); h.submit()
  await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledOnce())
  expect(h.request).toHaveBeenCalledOnce()
  expect(h.request.mock.calls[0][0].version.amountCents).toBe(price === '5' ? 500 : 525)
  expect(text(h.render())).toContain('Borrador guardado')
  h.submit()
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2))
  expect(h.request.mock.calls[1][0].version).toBeNull()
})

it.each(['', '5.001', '-5', '1000000.01'])('rejects invalid catalogue price %s before saving', async price => {
  const h = editorHarness()
  input(h.render(), 'Precio sin impuestos').props.onChange({ target: { value: price } })
  h.submit()
  await vi.waitFor(() => expect(text(h.render())).toContain('Introduce un precio'))
  expect(h.request).not.toHaveBeenCalled()
})

it('keeps a saved draft saved when refreshing the catalogue fails', async () => {
  const h = editorHarness()
  h.onSaved.mockRejectedValue(new Error('No se pudo actualizar la lista'))
  h.submit()
  await vi.waitFor(() => expect(text(h.render())).toContain('No se pudo actualizar la lista'))
  expect(text(h.render())).toContain('Borrador guardado')
  h.submit()
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2))
  expect(h.request.mock.calls[1][0].version).toBeNull()
})

it('opens the existing catalogue without implicitly creating another tariff', async () => {
  const h = editorHarness(true)
  expect(button(h.render(), 'Guardar producto')).toBeDefined()
  h.submit()
  await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce())
  expect(h.request.mock.calls[0][0].version).toBeNull()
})

it('logs reviewed codes and sanitized Mollie diagnostics without request data or provider messages', () => {
  expect(billingFailureDiagnostic('quote', new Error('BILLING_INVALID_PROMOTION_CONTRACT'))).toMatchObject({ action: 'quote', code: 'BILLING_INVALID_PROMOTION_CONTRACT' })
  expect(billingFailureDiagnostic('quote', new MollieRequestError(422, 'consumerAccount'))).toMatchObject({ mollie: { status: 422, field: 'consumerAccount', outcome: 'rejected' } })
  expect(billingFailureDiagnostic('quote', new MollieRequestError(422, 'customer@example.com'))).toMatchObject({ mollie: { field: null } })
  expect(billingFailureDiagnostic('quote', new MollieRequestError(503, null))).toMatchObject({ mollie: { outcome: 'uncertain' } })
  expect(JSON.stringify(billingFailureDiagnostic('quote', new Error('private token and customer@example.com')))).not.toMatch(/private|token|@/)
})
