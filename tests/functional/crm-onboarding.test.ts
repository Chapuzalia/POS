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
  const topic = model.onboardingTopics.find(topic => topic.id === 'inventory-stock')
  if (!topic) throw new Error('Missing stock guide')
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

it('groups every permitted guide once and counts only reviewed guides available in each theme', () => {
  const topics = getOnboardingTopics(context, venue)
  const groups = model.getOnboardingGroups(topics, ['products', 'stock-targets', 'stock-targets', 'unknown'])
  expect(groups).toHaveLength(5)
  expect(groups.flatMap(group => group.guides.map(topic => topic.id)).sort()).toEqual(topics.map(topic => topic.id).sort())
  expect(groups.find(group => group.id === 'inventory')?.completed).toBe(1)
  expect(groups.reduce((sum, group) => sum + group.completed, 0)).toBe(2)
  const basicTopics = getOnboardingTopics({ ...context, features: [] }, venue)
  expect(model.getOnboardingGroups(basicTopics, []).map(group => group.id)).toEqual(['business', 'catalog', 'options'])
})

it('expands themes independently, retains them when returning to the index and launches the selected guide', () => {
  const start = vi.fn()
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/crm/onboarding/OnboardingIndex.tsx', import.meta.url), 'utf8'), 'OnboardingIndex', {
    'react/jsx-runtime': jsxRuntime,
    'react-dom': { createPortal: (children: unknown) => children },
    'lucide-react': { CheckCircle2: 'svg', ChevronDown: 'svg', Circle: 'svg', X: 'svg' },
    '../../../components/ui/Button': { Button: 'button' },
    './onboardingModel': model, './onboardingTours': { getOnboardingSteps },
  }, { document: { body: {} } })
  onTestFinished(() => runner.unmount())
  const props = { disabled: false, isOpen: true, onClose: vi.fn(), onStart: start, reviewed: ['products'], theme: 'light', topics: getOnboardingTopics(context, venue) }
  const render = (isOpen = true) => runner.render({ ...props, isOpen })
  const disclosures = () => nodes(render()).filter((node: { type?: string }) => node.type === 'details')
  expect(disclosures().map((node: { props: { open: boolean } }) => node.props.open)).toEqual([false, false, false, false, false])
  disclosures()[1].props.onToggle({ currentTarget: { open: true } })
  disclosures()[3].props.onToggle({ currentTarget: { open: true } })
  expect(render(false)).toBeNull()
  expect(disclosures().map((node: { props: { open: boolean } }) => node.props.open)).toEqual([false, true, false, true, false])
  nodes(render()).find((node: { props?: { 'aria-label'?: string } }) => node.props?.['aria-label'] === 'Iniciar guía: Definir el stock objetivo')?.props.onClick()
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'stock-targets' }))
  disclosures()[1].props.onToggle({ currentTarget: { open: false } })
  expect(disclosures()[1].props.open).toBe(false)
  expect(disclosures()[3].props.open).toBe(true)
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
  const navigate = vi.fn()
  const observers: Array<() => void> = []
  let dialog: { querySelector: () => object | null } | null = null
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/crm/onboarding/CrmOnboarding.tsx', import.meta.url), 'utf8'), 'default', {
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { BookOpen: 'svg' }, 'driver.js': { driver: (config: GuideConfig) => { guideConfig = config; return guide } },
    'driver.js/dist/driver.css': {}, './onboarding.css': {}, './OnboardingIndex': { OnboardingIndex: 'onboarding-index' },
    '../../../components/ui/Button': { Button: 'button' }, '../shared/components/CrmModal': { CrmModal: 'dialog' },
    '../../billing/service': { billingRequest: request }, './onboardingModel': {
      ...model, readOnboardingProgress: (key: string) => readOnboardingProgress(key, storage),
      writeOnboardingProgress: (key: string, value: model.OnboardingProgress) => writeOnboardingProgress(key, value, storage),
    },
    './onboardingTours': { getOnboardingSteps }, '../../../utils/notifications': { notifyOperationalError: vi.fn() },
  }, {
    window: { localStorage: storage, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null, querySelectorAll: () => ({ length: dialog ? 1 : 0, item: () => dialog }), body: {} }, MutationObserver: class { constructor(callback: () => void) { observers.push(callback) } observe() {} disconnect() {} },
  })
  onTestFinished(() => runner.unmount())
  let openRequest = 0
  const render = (activeSection = 'dashboard', isOnline = true) => runner.render({ context, venue, activeSection, isOnline, disabled: false, onSectionChange: navigate, openRequest })
  const open = () => { openRequest += 1; render() }
  const click = (tree: unknown, label: string) => nodes(tree).find((node: { props?: { 'aria-label'?: string; children?: unknown } }) => node.props?.['aria-label'] === label || node.props?.children === label)?.props.onClick()
  const indexProps = () => nodes(render()).find((node: { type?: string }) => node.type === 'onboarding-index')?.props
  return { render, click, open, request, navigate, guide, store,
    setDialog: (known: boolean | null) => { dialog = known === null ? null : { querySelector: () => known ? {} : null }; observers.forEach(callback => callback()) },
    startProduct: () => indexProps()?.onStart(model.onboardingTopics.find(topic => topic.id === 'products')),
    finish: () => guideConfig?.onDoneClick(), productReviewed: () => indexProps()?.reviewed.includes('products'),
    isIndexOpen: () => indexProps()?.isOpen,
  }
}

it('opens the optional welcome after verification, remembers postponement, and keeps manual help available', async () => {
  const f = setup()
  f.render()
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
  expect(nodes(f.render()).some((node: { props?: { label?: string } }) => node.props?.label === 'Bienvenido a Tickit')).toBe(true)
  f.click(f.render(), 'Más tarde')
  expect(nodes(f.render()).some((node: { props?: { label?: string } }) => node.props?.label === 'Bienvenido a Tickit')).toBe(false)
  expect([...f.store.values()].some(value => JSON.parse(value).offered)).toBe(true)
  f.open()
  f.render()
  expect(f.isIndexOpen()).toBe(true)
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
  f.open()
  f.render()
  expect(f.isIndexOpen()).toBe(true)
})

it('marks only a finished guide as reviewed, permits topic jumps and cleans up on navigation/offline', () => {
  const f = setup()
  f.open()
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
  expect(f.productReviewed()).toBe(true)
  f.startProduct()
  f.render('products', false)
  expect(f.guide.destroy).toHaveBeenCalledTimes(3)
})


it('pauses safely when another editor takes focus and returns to the index after closing it', () => {
  const f = setup()
  f.open()
  f.render()
  f.startProduct()
  f.setDialog(true)
  expect(f.guide.destroy).not.toHaveBeenCalled()
  f.setDialog(false)
  expect(f.guide.destroy).toHaveBeenCalledOnce()
  expect(f.isIndexOpen()).toBe(false)
  expect(f.productReviewed()).toBe(false)
  f.setDialog(null)
  expect(f.isIndexOpen()).toBe(true)
})
