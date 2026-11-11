import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PrintTemplateDefinition } from '../../src/features/print-templates/types'
import type { SaleCreatedPayload } from '../../src/types'

const backend = vi.hoisted(() => ({
  read: vi.fn(), save: vi.fn(), remove: vi.fn(), signals: [] as AbortSignal[],
}))
vi.mock('../../src/lib/supabase.ts', () => ({ supabase: null }))
vi.mock('../../src/services/backendService.ts', () => ({
  requireSupabase: () => ({
    rpc: backend.save,
    from(table: string) {
      let deleting = false
      const query = {
        select() { return query }, eq() { return query },
        delete() { deleting = true; return query },
        abortSignal(signal: AbortSignal) { backend.signals.push(signal); return query },
        maybeSingle() { return backend.read(table) },
        then(resolve: (result: unknown) => void) { return Promise.resolve(deleting ? backend.remove() : backend.read(table)).then(resolve) },
      }
      return query
    },
  }),
}))

const context = { tenantId: 'tenant', venueId: 'venue' }
const definition = (text: string): PrintTemplateDefinition => ({ version: 1, blocks: [{ id: 'custom', type: 'text', value: text }] })
let service: typeof import('../../src/features/print-templates/service')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  backend.signals.length = 0
  backend.read.mockReset().mockResolvedValue({ data: null, error: null })
  backend.save.mockReset().mockResolvedValue({ error: null })
  backend.remove.mockReset().mockResolvedValue({ error: null })
  service = await import('../../src/features/print-templates/service')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('continues with a safe template when the backend hangs even if it ignores abort', async () => {
  backend.read.mockReturnValue(new Promise(() => {}))
  let resolved = false
  const pending = service.resolvePrintTemplate(context, 'test').then(result => { resolved = true; return result })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(resolved).toBe(true)
  expect((await pending).source).toBe('safe-default')
  expect(backend.signals.every(signal => signal.aborted)).toBe(true)
  expect(backend.signals.length).toBeGreaterThan(0)
})

it('reuses valid templates immediately and isolates tenant, venue and document type', async () => {
  backend.read.mockResolvedValue({ data: { is_active: true, definition: definition('Venue A') }, error: null })
  const first = await service.resolvePrintTemplate(context, 'test')
  first.definition.blocks.length = 0
  backend.read.mockReturnValue(new Promise(() => {}))
  let cached = false
  const pending = service.resolvePrintTemplate(context, 'test').then(result => { cached = true; return result })
  await vi.advanceTimersByTimeAsync(0)
  expect(cached).toBe(true)
  expect((await pending).definition.blocks).toEqual(definition('Venue A').blocks)
  for (const [scope, type] of [
    [{ ...context, tenantId: 'other' }, 'test'],
    [{ ...context, venueId: 'other' }, 'test'],
    [context, 'production'],
  ] as const) {
    const other = service.resolvePrintTemplate(scope, type)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await other).source).toBe('safe-default')
  }
})

it('retains the last valid template when refresh fails and does not cache invalid data', async () => {
  backend.read.mockResolvedValue({ data: { is_active: true, definition: definition('Retained') }, error: null })
  await service.resolvePrintTemplate(context, 'test')
  await vi.advanceTimersByTimeAsync(60_001)
  backend.read.mockResolvedValue({ data: { is_active: true, definition: { version: 99 } }, error: null })
  expect((await service.resolvePrintTemplate(context, 'test')).definition.blocks).toEqual(definition('Retained').blocks)
})

it('invalidates a saved template and a restored default in the same scope', async () => {
  backend.read.mockResolvedValue({ data: { is_active: true, definition: definition('Before') }, error: null })
  await service.resolvePrintTemplate(context, 'test')
  await service.savePrintTemplate(context, 'test', definition('After'))
  backend.read.mockResolvedValue({ data: { is_active: true, definition: definition('After') }, error: null })
  expect((await service.resolvePrintTemplate(context, 'test')).definition.blocks).toEqual(definition('After').blocks)
  backend.read.mockImplementation((table: string) => Promise.resolve({
    data: table === 'print_templates' ? null : { definition: definition('Default') }, error: null,
  }))
  expect((await service.restoreDefaultPrintTemplate(context, 'test')).definition.blocks).toEqual(definition('Default').blocks)
})

it('prints through the LAN after the cloud template timeout', async () => {
  vi.stubGlobal('window', { location: { pathname: '/pos' } })
  const { printCompletedSale } = await import('../../src/features/local-printing/services/printCompletedSale')
  const { usePrintAgentStore } = await import('../../src/features/local-printing/store/usePrintAgentStore')
  const sale: SaleCreatedPayload = {
    ticket: { id: 'ticket', tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user',
      cashSessionId: 'session', cashRegisterId: 'register', subtotalCents: 0, totalCents: 0,
      discount: null, discountAmountCents: 0, createdAt: '2026-11-02T10:00:00Z' },
    sale: { id: 'sale', tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user',
      ticketId: 'ticket', cashSessionId: 'session', cashRegisterId: 'register', totalCents: 0,
      paymentMethod: null, createdAt: '2026-11-02T10:00:00Z' },
    lines: [], payment: null,
  }
  let printed: unknown
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === '/api/v1/printers/selected') {
      return Response.json({ printer: { id: 'printer', paperWidth: 80, characterSet: 'CP858' } })
    }
    if (new URL(url).pathname === '/api/v1/print') {
      printed = JSON.parse(String(init.body))
      return Response.json({ ok: true, jobId: 'lan-job', status: 'printed' })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  usePrintAgentStore.setState({ baseUrl: 'https://agent.test', token: 'token', selectedPrinterId: 'printer' })
  backend.read.mockReturnValue(new Promise(() => {}))
  const pending = printCompletedSale({ context, sale, establishment: { name: 'Venue' } })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await pending).toMatchObject({ jobId: 'lan-job', status: 'printed' })
  expect(printed).toMatchObject({ requestId: 'print:sale:original', printerId: 'printer', lines: expect.any(Array) })
})

it('does not let a late cloud reply repopulate a template invalidated by a save', async () => {
  let finish: (value: unknown) => void = () => {}
  backend.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const pending = service.resolvePrintTemplate(context, 'test')
  await service.savePrintTemplate(context, 'test', definition('New'))
  finish({ data: { is_active: true, definition: definition('Old') }, error: null })
  await pending
  backend.read.mockResolvedValue({ data: { is_active: true, definition: definition('New') }, error: null })
  expect((await service.resolvePrintTemplate(context, 'test')).definition.blocks).toEqual(definition('New').blocks)
})
