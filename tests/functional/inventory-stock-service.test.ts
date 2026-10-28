import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, datasets, requests, rpc } = vi.hoisted(() => ({
  client: { from: vi.fn(), rpc: vi.fn() },
  datasets: new Map<string, Array<Record<string, unknown>>>(),
  requests: [] as Array<{ table: string; filters: Array<[string, unknown]>; order: string[]; range: number[] }>,
  rpc: vi.fn(),
}))
vi.mock('../../src/features/crm/shared/services/crmServiceSupport', () => ({ requireSupabase: () => client }))
vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError: vi.fn() }))

import { loadInventoryItemMovements, loadInventoryItemVariantCount, loadInventoryStockPageData, saveInventoryItemStock, saveInventoryItem } from '../../src/features/crm/inventory/services/inventoryService'
import type { TenantContext } from '../../src/types'

beforeEach(() => {
  datasets.clear(); requests.length = 0
  client.rpc.mockImplementation(rpc)
  rpc.mockResolvedValue({ data: null, error: null })
  client.from.mockImplementation((table: string) => {
    const request = { table, filters: [] as Array<[string, unknown]>, order: [] as string[], range: [] as number[] }
    requests.push(request)
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: (column: string, value: unknown) => { request.filters.push([column, value]); return builder },
      gte: (column: string, value: unknown) => { request.filters.push([`gte:${column}`, value]); return builder },
      lt: (column: string, value: unknown) => { request.filters.push([`lt:${column}`, value]); return builder },
      order: (column: string) => { request.order.push(column); return builder },
      range: async (from: number, to: number) => {
        request.range = [from, to]
        const rows = datasets.get(table) ?? []
        return { data: rows.slice(from, to + 1), count: rows.length, error: null }
      },
    }
    return builder
  })
})

describe('scoped stock queries and safe write protocol', () => {
  it('loads distinct linked variants only for the selected article, tenant and venue', async () => {
    datasets.set('inventory_recipe_lines', Array.from({ length: 1005 }, (_, i) => ({ id: `line-${i}`, recipe_id: `recipe-${i % 101}` })))
    expect(await loadInventoryItemVariantCount({ tenantId: 'tenant' }, 'venue', 'item')).toBe(101)
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(request.filters).toEqual([['tenant_id', 'tenant'], ['venue_id', 'venue'], ['inventory_item_id', 'item']])
  })
  it('reuses the existing article RPC without including any stock quantity fields', async () => {
    rpc.mockResolvedValueOnce({ data: 'created-item', error: null })
    expect(await saveInventoryItem('venue', { id: null, name: 'Harina', description: 'Integral', baseUnitId: 'kg', active: true, routes: [{ warehouseId: 'bar', priority: 1, enabled: true, targetQuantity: 12.5 }] })).toBe('created-item')
    expect(rpc).toHaveBeenCalledWith('save_inventory_item', { p_venue_id: 'venue', p_inventory_item_id: null, p_name: 'Harina', p_description: 'Integral', p_base_unit_id: 'kg', p_active: true, p_routes: [{ warehouseId: 'bar', priority: 1, enabled: true, targetQuantity: 12.5 }] })
  })
  it('loads stock beyond the PostgREST default cap and scopes every page to tenant and venue', async () => {
    datasets.set('inventory_stock_levels', Array.from({ length: 1205 }, (_, i) => ({ inventory_item_id: `item-${i}`, warehouse_id: 'warehouse', quantity: i - 600, is_enabled: true, target_quantity: 24 })))
    const data = await loadInventoryStockPageData({ tenantId: 'tenant' }, 'venue')
    expect(data.levels).toHaveLength(1205)
    expect(data.levels[1204].quantity).toBe(604)
    expect(requests.filter((request) => request.table === 'inventory_stock_levels').map((request) => request.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
    for (const request of requests) {
      expect(request.filters).toEqual([['tenant_id', 'tenant'], ['venue_id', 'venue']])
      expect(request.order.length).toBeGreaterThan(0)
    }
  })
  it('paginates history with a stable order and preserves item/warehouse/time filters', async () => {
    await loadInventoryItemMovements({ tenantId: 'tenant' }, 'venue', 'item', '2026-10-01', '2026-10-28', 'bar', 50)
    expect(requests[0]).toEqual({ table: 'inventory_stock_movements', filters: [['tenant_id', 'tenant'], ['venue_id', 'venue'], ['inventory_item_id', 'item'], ['gte:created_at', '2026-10-01'], ['lt:created_at', '2026-10-28'], ['warehouse_id', 'bar']], order: ['created_at', 'id'], range: [50, 99] })
  })
  it('uses the new entry point so an old server cannot treat an addition as an absolute total', async () => {
    await saveInventoryItemStock({ tenantId: 'tenant' } as TenantContext, 'venue', 'item', [{ enabled: true, warehouseId: 'bar', quantity: 2.125, expectedQuantity: -2 }], { mode: 'add', requestId: 'request-1' })
    expect(rpc).toHaveBeenCalledWith('update_inventory_item_stock', { p_tenant_id: 'tenant', p_venue_id: 'venue', p_inventory_item_id: 'item', p_levels: [{ enabled: true, warehouseId: 'bar', quantity: 2.125, expectedQuantity: -2, mode: 'add', requestId: 'request-1' }] })
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing function' } })
    await expect(saveInventoryItemStock({ tenantId: 'tenant' } as TenantContext, 'venue', 'item', [], { mode: 'add', requestId: 'request-1' })).rejects.toThrow('migración de trazabilidad')
    expect(rpc.mock.calls.every(([name]) => name === 'update_inventory_item_stock')).toBe(true)
  })
})
