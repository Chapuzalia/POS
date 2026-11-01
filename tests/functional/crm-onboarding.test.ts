import { readFileSync } from 'node:fs'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { CrmVenue, TenantContext } from '../../src/types'
import type { BillingDetail } from '../../src/features/billing/types'
import { getOnboardingTopics, onboardingStorageKey, readOnboardingProgress, shouldOfferOnboarding, writeOnboardingProgress } from '../../src/features/crm/onboarding/onboardingModel'
import * as model from '../../src/features/crm/onboarding/onboardingModel'
import { getOnboardingSteps } from '../../src/features/crm/onboarding/onboardingTours'
import type { Driver, HookOpts } from 'driver.js'
import { continueWhen } from '../../src/features/crm/onboarding/onboardingTours'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const context: TenantContext = {
  tenantId: 'tenant', tenantName: 'Café', tenantSlug: 'cafe', venueId: 'venue', venueName: 'Sala',
  deviceId: 'device', deviceName: 'CRM', userId: 'owner', userName: 'Ana', role: 'owner', features: ['inventory', 'restaurant'],
}
const venue: CrmVenue = {
  id: 'venue', name: 'Sala', catalogProfile: 'restaurant', address: '', dayChangeTime: null, legalName: '', taxId: '',
  sortOrder: 0, isActive: true, inventoryEnabled: true, tablesEnabled: true, productionEnabled: false,
  addonActivations: {}, defaultTaxRate: 21, timeZone: 'Europe/Madrid',
}
const detail = {
  account: { tenant_id: 'tenant', source: 'stripe', onboarding_contract: {} },
  tenant: { id: 'tenant', billing_activation_required: false },
} as BillingDetail

it('offers the guide only to an activated Stripe owner with a matching verified account', () => {
  const progress = { offered: false, reviewed: [] }
  expect(shouldOfferOnboarding(context, detail, progress)).toBe(true)
  expect(shouldOfferOnboarding({ ...context, billingActivationRequired: true }, detail, progress)).toBe(false)
  expect(shouldOfferOnboarding({ ...context, role: 'manager' }, detail, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, detail, { ...progress, offered: true })).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, tenant: { ...detail.tenant, billing_activation_required: true } }, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, tenant: { ...detail.tenant, billing_activation_required: undefined } }, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, account: { ...detail.account, source: 'manual' } }, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, account: { ...detail.account, tenant_id: 'other' } }, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, tenant: { ...detail.tenant, id: 'other' } }, progress)).toBe(false)
  expect(shouldOfferOnboarding(context, { ...detail, account: { ...detail.account, onboarding_contract: null } }, progress)).toBe(false)
})

it('uses the same role, feature and local activation checks as CRM navigation', () => {
  expect(getOnboardingTopics(context, venue).map(topic => topic.id)).toContain('tables')
  expect(getOnboardingTopics({ ...context, features: [] }, venue).map(topic => topic.id)).not.toContain('tables')
  expect(getOnboardingTopics(context, { ...venue, addonActivations: { inventory: false } }).map(topic => topic.id)).not.toContain('inventory-stock')
  expect(getOnboardingTopics(context, { ...venue, tablesEnabled: false }).map(topic => topic.id)).not.toContain('tables')
  expect(getOnboardingTopics({ ...context, role: 'cashier' }, venue)).toEqual([])
  expect(getOnboardingTopics({ ...context, role: 'manager' }, venue).map(topic => topic.id)).not.toContain('users')
  expect(getOnboardingTopics({ ...context, features: [] }, venue).map(topic => topic.id)).not.toContain('product-inventory')
  expect(getOnboardingTopics({ ...context, billingActivationRequired: true }, venue)).toEqual([])
})

it('keeps the explanation visible until the user has opened the required editor', () => {
  const hint = { dataset: {}, setAttribute: vi.fn(), className: '', textContent: '' }
  const description = { querySelector: vi.fn(() => null), appendChild: vi.fn() }
  const querySelector = vi.fn((): object | null => null)
  vi.stubGlobal('document', { querySelector, createElement: () => hint })
  onTestFinished(() => vi.unstubAllGlobals())
  const moveNext = vi.fn()
  const driver = { moveNext, getState: () => ({ popover: { description } }) } as unknown as Driver
  const opts: HookOpts = { driver, config: {}, state: {}, index: 0 }
  const next = continueWhen('[data-onboarding="product-assignments"]', 'Abre la ficha de un producto antes de continuar.')
  next?.(undefined, {}, opts)
  expect(moveNext).not.toHaveBeenCalled()
  expect(hint.textContent).toBe('Abre la ficha de un producto antes de continuar.')
  expect(description.appendChild).toHaveBeenCalledWith(hint)
  querySelector.mockReturnValue({})
  next?.(undefined, {}, opts)
  expect(moveNext).toHaveBeenCalledOnce()
})

it('does not advance or click a disabled creation control', () => {
  class Control { disabled = true; click = vi.fn() }
  vi.stubGlobal('HTMLButtonElement', Control)
  vi.stubGlobal('document', { createElement: () => ({ dataset: {}, setAttribute: vi.fn() }) })
  onTestFinished(() => vi.unstubAllGlobals())
  const moveNext = vi.fn()
  const description = { querySelector: () => ({ textContent: '' }) }
  const driver = { moveNext, getState: () => ({ popover: { description } }) } as unknown as Driver
  const button = new Control()
  const topic = model.onboardingTopics.find(topic => topic.id === 'inventory-stock')!
  const open = getOnboardingSteps(topic)[0].popover?.onNextClick
  open?.(button as unknown as Element, {}, { driver, config: {}, state: {}, index: 0 })
  expect(button.click).not.toHaveBeenCalled()
  expect(moveNext).not.toHaveBeenCalled()
  button.disabled = false
  open?.(button as unknown as Element, {}, { driver, config: {}, state: {}, index: 0 })
  expect(button.click).toHaveBeenCalledOnce()
  expect(moveNext).toHaveBeenCalledOnce()
})

it('provides multi-step task flows with separate guides for assignments, targets, real totals and replenishment', () => {
  const topics = getOnboardingTopics(context, venue)
  expect(topics.map(topic => topic.id)).toEqual(expect.arrayContaining(['mixers', 'product-mixers', 'stock-targets', 'stock-count', 'stock-replenishment', 'product-inventory']))
  for (const topic of topics) expect(getOnboardingSteps(topic).length, topic.id).toBeGreaterThanOrEqual(4)
})

it('keeps progress separate per tenant, user and venue and tolerates blocked or corrupt storage', () => {
  const key = onboardingStorageKey(context, venue.id)
  expect(onboardingStorageKey({ ...context, tenantId: 'other' }, venue.id)).not.toBe(key)
  expect(onboardingStorageKey({ ...context, userId: 'other' }, venue.id)).not.toBe(key)
  expect(onboardingStorageKey(context, 'other')).not.toBe(key)
  const storage = { getItem: vi.fn(() => '{broken'), setItem: vi.fn() }
  expect(readOnboardingProgress(key, storage)).toEqual({ offered: false, reviewed: [] })
  storage.getItem.mockReturnValue(JSON.stringify({ offered: true, reviewed: ['products', 'unknown', 4] }))
  expect(readOnboardingProgress(key, storage)).toEqual({ offered: true, reviewed: ['products'] })
  writeOnboardingProgress(key, { offered: true, reviewed: ['products'] }, storage)
  expect(storage.setItem).toHaveBeenCalledWith(key, JSON.stringify({ offered: true, reviewed: ['products'] }))
  storage.getItem.mockImplementation(() => { throw new Error('blocked') })
  storage.setItem.mockImplementation(() => { throw new Error('blocked') })
  expect(readOnboardingProgress(key, storage)).toEqual({ offered: false, reviewed: [] })
  expect(() => writeOnboardingProgress(key, { offered: true, reviewed: [] }, storage)).not.toThrow()
})

function setup(response = detail) {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  const request = vi.fn(async () => response)
  type GuideConfig = { onDoneClick: () => void; onDestroyed: () => void }
  let guideConfig: GuideConfig | undefined
  const guide = { drive: vi.fn(), destroy: vi.fn(() => guideConfig?.onDestroyed()) }
  let checklistConfig: { items: Array<{ id: string; action: () => void; completeWhen: () => boolean }> } | undefined
  const widget = { show: vi.fn(), hide: vi.fn(), open: vi.fn(), complete: vi.fn() }
  const navigate = vi.fn()
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/crm/onboarding/CrmOnboarding.tsx', import.meta.url), 'utf8'), 'default', {
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { BookOpen: 'svg' }, 'driver.js': { driver: (config: GuideConfig) => { guideConfig = config; return guide } },
    'driver.js/checklist': { checklist: (config: typeof checklistConfig) => { checklistConfig = config; return widget } },
    'driver.js/dist/driver.css': {}, 'driver.js/dist/checklist.css': {}, './onboarding.css': {},
    '../../../components/ui/Button': { Button: 'button' }, '../shared/components/CrmModal': { CrmModal: 'dialog' },
    '../../billing/service': { billingRequest: request }, './onboardingModel': {
      ...model, readOnboardingProgress: (key: string) => readOnboardingProgress(key, storage),
      writeOnboardingProgress: (key: string, value: model.OnboardingProgress) => writeOnboardingProgress(key, value, storage),
    },
    './onboardingTours': { getOnboardingSteps }, '../../../utils/notifications': { notifyOperationalError: vi.fn() },
  }, {
    window: { localStorage: storage, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, body: {} }, MutationObserver: class { observe() {} disconnect() {} },
  })
  onTestFinished(() => runner.unmount())
  const render = (activeSection = 'dashboard', isOnline = true) => runner.render({ context, venue, activeSection, isOnline, disabled: false, onSectionChange: navigate })
  const click = (tree: unknown, label: string) => nodes(tree).find((node: { props?: { 'aria-label'?: string; children?: unknown } }) => node.props?.['aria-label'] === label || node.props?.children === label)?.props.onClick()
  return { render, click, request, navigate, widget, guide, store, startProduct: () => checklistConfig?.items.find(item => item.id === 'products')?.action(), finish: () => guideConfig?.onDoneClick(), productReviewed: () => checklistConfig?.items.find(item => item.id === 'products')?.completeWhen() }
}

it('opens the optional welcome after verification, remembers postponement, and keeps manual help available', async () => {
  const f = setup()
  f.render()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
  expect(nodes(f.render()).some((node: { props?: { label?: string } }) => node.props?.label === 'Bienvenido a Tickit')).toBe(true)
  f.click(f.render(), 'Más tarde')
  expect(nodes(f.render()).some((node: { props?: { label?: string } }) => node.props?.label === 'Bienvenido a Tickit')).toBe(false)
  expect([...f.store.values()].some(value => JSON.parse(value).offered)).toBe(true)
  f.click(f.render(), 'Inicio guiado')
  f.render()
  expect(f.widget.open).toHaveBeenCalled()
})

it('does not offer unconfirmed accounts or interrupt the CRM after a billing read error', async () => {
  const f = setup({ ...detail, tenant: { ...detail.tenant, billing_activation_required: true } })
  f.render('dashboard', false)
  expect(f.request).not.toHaveBeenCalled()
  f.render()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
  expect(nodes(f.render()).some((node: { props?: { label?: string } }) => node.props?.label === 'Bienvenido a Tickit')).toBe(false)
  f.request.mockRejectedValueOnce(new Error('unavailable'))
  f.render('dashboard', false)
  f.render()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2))
  expect(nodes(f.render()).some((node: { props?: { 'aria-label'?: string } }) => node.props?.['aria-label'] === 'Inicio guiado')).toBe(true)
})

it('marks only a finished guide as reviewed, permits topic jumps and cleans up on navigation/offline', () => {
  const f = setup()
  f.click(f.render(), 'Inicio guiado')
  f.render()
  f.startProduct()
  expect(f.navigate).toHaveBeenCalledWith('products')
  expect(f.guide.drive).toHaveBeenCalledOnce()
  expect(f.productReviewed()).toBe(false)
  f.render('products')
  f.render('categories')
  expect(f.guide.destroy).toHaveBeenCalledOnce()
  expect(f.productReviewed()).toBe(false)
  f.startProduct()
  f.render('products')
  f.finish()
  expect(f.widget.complete).toHaveBeenCalledWith('products')
  expect(f.productReviewed()).toBe(true)
  f.startProduct()
  f.render('products', false)
  expect(f.guide.destroy).toHaveBeenCalledTimes(3)
})
