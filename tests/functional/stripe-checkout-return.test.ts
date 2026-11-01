import { readFileSync } from 'node:fs'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

function setup(search = '?billing=success', customerId: string | null = 'cus_test') {
  let activationRequired = true
  let verified = false
  const onActivated = vi.fn()
  const request = vi.fn(async ({ action }: { action: string }) => {
    if (action === 'reconcile') { if (verified) activationRequired = false; return {} }
    if (action === 'catalog') return { products: [], versions: [] }
    return { account: { stripe_customer_id: customerId, onboarding_contract: null }, tenant: { billing_activation_required: activationRequired }, operations: [] }
  })
  let poll: (() => void) | undefined
  const clearInterval = vi.fn()
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/billing/BillingActivationPanel.tsx', import.meta.url), 'utf8'), 'BillingActivationPanel', {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Button': { Button: 'button' },
    '../../components/ui/AppModal': { AppModal: 'dialog' },
    './BillingSelectionEditor': { BillingSelectionEditor: 'section' },
    './service': { billingRequest: request, billingMoney: String, openBillingUrl: vi.fn() },
    './selection': { buildContract: vi.fn() },
  }, { Error, URLSearchParams, window: { location: { search }, setInterval: (callback: () => void) => { poll = callback; return 1 }, clearInterval } })
  onTestFinished(() => runner.unmount())
  const render = (disabled = false) => runner.render({ tenantId: 'tenant', onActivated, disabled })
  return { request, onActivated, render, verify: () => { verified = true }, poll: () => poll?.(), clearInterval }
}

it('checks Stripe immediately on Checkout return and activates without a customer click', async () => {
  const fixture = setup()
  fixture.verify()
  fixture.render()
  await vi.waitFor(() => expect(fixture.onActivated).toHaveBeenCalledOnce())
  expect(fixture.request.mock.calls.map(([body]) => body.action)).toEqual(['get', 'catalog', 'reconcile', 'get', 'catalog'])
})

it('keeps polling when Stripe has not confirmed yet and activates automatically later', async () => {
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

it.each(['', '?billing=cancelled'])('loads normally without an immediate Stripe check for %s', async search => {
  const fixture = setup(search)
  fixture.render()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
  expect(fixture.request.mock.calls.some(([body]) => body.action === 'reconcile')).toBe(false)
  expect(fixture.onActivated).not.toHaveBeenCalled()
})

it('does not reconcile without a Stripe customer or while offline', async () => {
  const fixture = setup('?billing=success', null)
  fixture.render(true)
  expect(fixture.request).not.toHaveBeenCalled()
  fixture.render()
  await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
  expect(fixture.onActivated).not.toHaveBeenCalled()
})

it('shows a verification failure and recovers through the automatic poll', async () => {
  const fixture = setup()
  fixture.request.mockImplementationOnce(async () => ({ account: { stripe_customer_id: 'cus_test', onboarding_contract: null }, tenant: { billing_activation_required: true }, operations: [] }))
  fixture.request.mockImplementationOnce(async () => ({ products: [], versions: [] }))
  fixture.request.mockRejectedValueOnce(new Error('No se pudo comprobar el pago.'))
  fixture.render()
  await vi.waitFor(() => expect(nodes(fixture.render()).some(node => node.props?.role === 'alert' && node.props.children === 'No se pudo comprobar el pago.')).toBe(true))
  expect(fixture.onActivated).not.toHaveBeenCalled()
  fixture.verify()
  fixture.poll()
  await vi.waitFor(() => expect(fixture.onActivated).toHaveBeenCalledOnce())
})
