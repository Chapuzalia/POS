import { sepaAuthorizationVersion } from '../../supabase/functions/_shared/billing/sepa'
import { readFileSync } from 'node:fs'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import * as sepaFields from '../../src/features/billing/sepa'
import * as legalFields from '../../supabase/functions/_shared/billing/legal'

function setup(search = '?billing=success', customerId: string | null = 'cst_test', operations: Array<{ id: string; status: string; result?: { url?: string } | null }> = []) {
  let activationRequired = true
  let verified = false
  const onActivated = vi.fn()
  const openBillingUrl = vi.fn()
  const contract = { planName: 'Plan de prueba', recurringCents: 4900, interval: 'month', limits: { venues: 1, devices: 2 }, addons: [], selection: { planVersionId: 'plan', addons: [] } }
  const request = vi.fn(async ({ action }: { action: string }) => {
    if (action === 'reconcile') { if (verified) activationRequired = false; return {} }
    if (action === 'catalog') return { products: [], versions: [] }
    if (action === 'quote') return { id: 'new-quote', contract, preview: { amountDueCents: 5929 } }
    if (action === 'confirm') return { url: 'https://www.mollie.com/checkout/new', acceptance: { operation_id: 'new-quote', accepted_at: '2026-11-12T10:00:00Z', receipt: {} } }
    return { account: { stripe_customer_id: customerId, onboarding_contract: operations.length ? contract : null }, tenant: { billing_activation_required: activationRequired }, operations }
  })
  let poll: (() => void) | undefined
  const clearInterval = vi.fn()
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/billing/BillingActivationPanel.tsx', import.meta.url), 'utf8'), 'BillingActivationPanel', {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Button': { Button: 'button' },
    '../../components/ui/AppModal': { AppModal: 'dialog' },
    '../../components/ui/Checkbox': { Checkbox: 'checkbox' },
    '../../components/ui/Input': { Input: 'input' },
    './BillingSelectionEditor': { BillingSelectionEditor: 'section' },
    './SepaMandateFields': { SepaMandateFields: 'sepa-fields' },
    './sepa': sepaFields,
    './BillingLegalAcceptance': { ...legalFields, BillingLegalAcceptance: 'legal-fields', BillingLegalLinks: 'legal-links', BillingOfferSummary: 'offer-summary' },
    './BillingLegalReceipt': { BillingLegalReceipt: 'legal-receipt' },
    '../../../supabase/functions/_shared/billing/legal': legalFields,
    './service': { billingRequest: request, billingMoney: String, openBillingUrl },
    './selection': { buildContract: vi.fn() },
  }, { Error, URLSearchParams, window: { location: { search }, setInterval: (callback: () => void) => { poll = callback; return 1 }, clearInterval } })
  onTestFinished(() => runner.unmount())
  const render = (disabled = false) => runner.render({ tenantId: 'tenant', onActivated, disabled })
  // The owner must authorize the SEPA mandate before the first card payment.
  const fillSepa = async () => {
    const form = { legalName: 'Restaurante Prueba SL', taxId: 'B12345678', email: 'billing@example.test', address: { street: 'Calle Mayor 1', postalCode: '28001', city: 'Madrid', province: 'Madrid', countryCode: 'ES' }, accountHolder: 'Restaurante Prueba SL', iban: 'ES91 2100 0418 4502 0005 1332', accepted: true }
    nodes(render()).find(node => node.type === 'sepa-fields')?.props.onChange(form)
    await vi.waitFor(() => expect(nodes(render()).find(node => node.type === 'sepa-fields')?.props.value).toEqual(form))
    expect(nodes(render()).find(node => node.type === 'button' && node.props.children === 'Aceptar y pagar')?.props.disabled).toBe(true)
    nodes(render()).find(node => node.type === 'legal-fields')?.props.onChange({ version: legalFields.billingLegalVersion, terms: true, dpa: true, businessRepresentative: true })
  }
  return { fillSepa, request, onActivated, openBillingUrl, render, verify: () => { verified = true }, poll: () => poll?.(), clearInterval }
}

it('checks Mollie immediately on Checkout return and activates without a customer click', async () => {
  const fixture = setup()
  fixture.verify()
  fixture.render()
  await vi.waitFor(() => expect(fixture.onActivated).toHaveBeenCalledOnce())
  expect(fixture.request.mock.calls.map(([body]) => body.action)).toEqual(['get', 'catalog', 'reconcile', 'get', 'catalog'])
})

it('keeps polling when Mollie has not confirmed yet and activates automatically later', async () => {
  const fixture = setup()
  fixture.render()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(5))
  fixture.render()
  expect(fixture.onActivated).not.toHaveBeenCalled()
  fixture.verify()
  fixture.poll()
  await vi.waitFor(() => expect(fixture.onActivated).toHaveBeenCalledOnce())
  expect(fixture.request.mock.calls.filter(([body]) => body.action === 'reconcile')).toHaveLength(2)
})

it.each(['', '?billing=cancelled'])('loads normally without an immediate Mollie check for %s', async search => {
  const fixture = setup(search)
  fixture.render()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
  expect(fixture.request.mock.calls.some(([body]) => body.action === 'reconcile')).toBe(false)
  expect(fixture.onActivated).not.toHaveBeenCalled()
})

it('does not reconcile without a Mollie customer or while offline', async () => {
  const fixture = setup('?billing=success', null)
  fixture.render(true)
  expect(fixture.request).not.toHaveBeenCalled()
  fixture.render()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
  expect(fixture.onActivated).not.toHaveBeenCalled()
})

it('shows a verification failure and recovers through the automatic poll', async () => {
  const fixture = setup()
  fixture.request.mockImplementationOnce(async () => ({ account: { stripe_customer_id: 'cst_test', onboarding_contract: null }, tenant: { billing_activation_required: true }, operations: [] }))
  fixture.request.mockImplementationOnce(async () => ({ products: [], versions: [] }))
  fixture.request.mockRejectedValueOnce(new Error('No se pudo comprobar el pago.'))
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.props?.role === 'alert' && node.props.children === 'No se pudo comprobar el pago.')).toBe(true))
  expect(fixture.onActivated).not.toHaveBeenCalled()
  fixture.verify()
  fixture.poll()
  await vi.waitFor(() => expect(fixture.onActivated).toHaveBeenCalledOnce())
})

it('does not claim to be checking a payment when Checkout creation is blocked without a URL', async () => {
  const fixture = setup('', 'cst_test', [{ id: 'blocked', status: 'applying', result: null }])
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'h3' && node.props.children === 'Plan de prueba')).toBe(true))
  const tree = nodes(fixture.render())
  expect(tree.some(node => node.props?.role === 'alert' && String(node.props.children).includes('La apertura de la página de pago no se ha completado'))).toBe(true)
  expect(tree.some(node => String(node.props?.children).includes('Estamos comprobando'))).toBe(false)
  expect(tree.find(node => node.type === 'button' && node.props.children === 'Pagar con Mollie')?.props.disabled).toBe(true)
})

it('opens an existing Checkout instead of claiming that payment is already being checked', async () => {
  const fixture = setup('', 'cst_test', [{ id: 'ready', status: 'payment_pending', result: { url: 'https://www.mollie.com/checkout/ready' } }])
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'h3' && node.props.children === 'Plan de prueba')).toBe(true))
  const tree = nodes(fixture.render())
  expect(tree.some(node => node.props?.role === 'status' && String(node.props.children).includes('Tu página de pago está lista'))).toBe(true)
  const button = tree.find(node => node.type === 'button' && node.props.children === 'Continuar pago en Mollie')
  expect(button?.props.disabled).toBe(false)
  button?.props.onClick()
  await vi.waitFor(() => expect(fixture.openBillingUrl).toHaveBeenCalledWith('https://www.mollie.com/checkout/ready'))
  expect(fixture.request.mock.calls.some(([body]) => body.action === 'quote')).toBe(false)
})

it('allows a fresh quote and navigates to Mollie after the rejected attempt is released', async () => {
  const fixture = setup('', 'cst_test', [{ id: 'rejected', status: 'failed', result: null }])
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'h3' && node.props.children === 'Plan de prueba')).toBe(true))
  const pay = nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Pagar con Mollie')
  expect(pay?.props.disabled).toBe(false)
  pay?.props.onClick()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'dialog')).toBe(true))
  expect(nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Aceptar y pagar')?.props.disabled).toBe(true)
  await fixture.fillSepa()
  const confirm = nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Aceptar y pagar')
  confirm?.props.onClick()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'confirm', sepa: { accountHolder: 'Restaurante Prueba SL', iban: 'ES91 2100 0418 4502 0005 1332', authorization: { version: sepaAuthorizationVersion, accepted: true } }, payer: { legalName: 'Restaurante Prueba SL', taxId: 'B12345678', email: 'billing@example.test', address: { street: 'Calle Mayor 1', postalCode: '28001', city: 'Madrid', province: 'Madrid', countryCode: 'ES' } } })))
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'legal-receipt' && node.props.acceptance.operation_id === 'new-quote')).toBe(true))
  expect(nodes(fixture.render()).some(node => node.type === 'dialog')).toBe(false)
  await vi.waitFor(() => expect(fixture.openBillingUrl).toHaveBeenCalledWith('https://www.mollie.com/checkout/new'))
})

it('shows a confirmation without a Checkout URL as an error and keeps the review open', async () => {
  const fixture = setup('', 'cst_test', [{ id: 'rejected', status: 'failed', result: null }])
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'h3' && node.props.children === 'Plan de prueba')).toBe(true))
  nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Pagar con Mollie')?.props.onClick()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.type === 'dialog')).toBe(true))
  await fixture.fillSepa()
  fixture.request.mockResolvedValueOnce({})
  nodes(fixture.render()).find(node => node.type === 'button' && node.props.children === 'Aceptar y pagar')?.props.onClick()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.props?.role === 'alert' && String(node.props.children).includes('No se ha podido abrir la página de pago'))).toBe(true))
  expect(nodes(fixture.render()).some(node => node.type === 'dialog')).toBe(true)
  expect(fixture.openBillingUrl).not.toHaveBeenCalled()
})
