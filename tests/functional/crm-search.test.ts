import { describe, expect, it, vi } from 'vitest'
import type { CatalogData } from '../../src/features/catalog/domain/types'
import type { CashClosingReportRecord } from '../../src/features/crm/sales/services/cashClosingReportModel'
import type { CrmSection } from '../../src/features/crm/routing/crmNavigation'

vi.mock('../../src/features/crm/catalog/services/catalogAdminService.ts', () => ({ catalogAdminService: { load: vi.fn() } }))
vi.mock('../../src/features/crm/sales/services/revoCashClosingService', () => ({ loadCashClosingReports: vi.fn() }))

const { buildCatalogSearchItems, buildCashClosingSearchItems } = await import('../../src/features/crm/search/crmSearchService')

const catalog = {
  products: [{ id: 'p1', name: 'Gin Tonic', active: true }, { id: 'p2', name: 'Café', active: false }],
  variants: [{ id: 'v1', productId: 'p1', name: 'Copa', sku: 'GT-01' }],
  saleFormats: [{ id: 'f1', name: 'Copa' }],
  categories: [{ id: 'c1', name: 'Combinados' }],
  selectionGroups: [{ id: 's1', name: 'Refrescos', type: 'mixer' }, { id: 's2', name: 'Menú', type: 'menu_course' }],
  modifierGroups: [{ id: 'm1', name: 'Hielo' }],
} as unknown as CatalogData

const all = new Set<CrmSection>(['products', 'formats', 'categories', 'selection-groups', 'modifiers'])

describe('CRM global search items', () => {
  it('indexes products with variant names and SKUs, formats, categories, mixers and modifiers', () => {
    const items = buildCatalogSearchItems(catalog, all)
    expect(items.map((item) => [item.section, item.targetId])).toEqual([
      ['products', 'p1'], ['products', 'p2'], ['formats', 'f1'], ['categories', 'c1'], ['selection-groups', 's1'], ['modifiers', 'm1'],
    ])
    expect(items[0].keywords).toContain('GT-01')
    expect(items[1].context).toBe('Producto · inactivo')
  })

  it('omits records from sections the user cannot access', () => {
    const items = buildCatalogSearchItems(catalog, new Set<CrmSection>(['formats']))
    expect(items.map((item) => item.section)).toEqual(['formats'])
  })

  it('labels native and imported cash closings by operational day', () => {
    const closings = [
      { id: 'n1', closedAt: '2026-11-07T22:00:00Z', printSnapshot: { timezone: 'Europe/Madrid', registerName: 'Caja 1', shiftLabel: 'Tarde', summary: { totalSalesCents: 12345 } } },
      { id: 'r1', source: 'revo', date: '2026-10-01', cashCents: 100, cardCents: 200 },
    ] as unknown as CashClosingReportRecord[]
    const items = buildCashClosingSearchItems(closings, { dayChangeTime: null, timeZone: 'Europe/Madrid' })
    expect(items.map((item) => item.label)).toEqual(['Cierre 07/11/2026 · Caja 1 Tarde', 'Cierre 01/10/2026 · REVO'])
    expect(items.every((item) => item.section === 'x-reports')).toBe(true)
    expect(items[1].targetId).toBe('r1')
  })
})
