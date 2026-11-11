import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { TenantContext } from '../../src/types'
import type { KdsQueue } from '../../src/features/production/types'
import { KdsPage } from '../../src/features/production/components/KdsPage'

const { useKdsQueue } = vi.hoisted(() => ({ useKdsQueue: vi.fn() }))
vi.mock('../../src/features/production/useKdsQueue', () => ({ useKdsQueue }))
vi.mock('../../src/features/production/service', () => ({}))
vi.mock('../../src/features/inventory', () => ({ InventoryPreparationsPanel: () => null }))

const context: TenantContext = {
  tenantId: 'tenant', tenantName: 'Restaurante', tenantSlug: 'restaurante',
  venueId: 'venue', venueName: 'Local', deviceId: 'kds', deviceName: 'Cocina', deviceMode: 'kds',
  userId: 'user', userName: 'Cocinero', role: 'cashier',
}

it.each([
  ['modified', 'Mesa 7', 'Mesa 7'],
  ['cancelled', 'Mesa 7 + Mesa 8', 'Mesa 7 + Mesa 8'],
  ['modified', undefined, 'Comanda'],
  ['cancelled', '  ', 'Comanda'],
] as const)('shows the table or fallback on %s notices with table %s', (eventType, tableName, expected) => {
  const queue: KdsQueue = {
    destinationId: 'kitchen', items: [], events: [{
      id: 'event', event_type: eventType, quantity: 1,
      payload: { productName: 'Hamburguesa', tableName, note: 'Sin cebolla' },
      created_at: '2026-10-28T19:00:00Z',
    }],
  }
  useKdsQueue.mockReturnValue({ queue, error: null, refresh: vi.fn() })
  const html = renderToStaticMarkup(createElement(KdsPage, { context, isOnline: true, onLogout: async () => undefined }))
  expect(html).toContain(expected)
  expect(html).toContain(eventType === 'modified' ? 'MODIFICACIÓN' : 'ANULACIÓN')
  if (eventType === 'modified') expect(html).toContain('Comentario: Sin cebolla')
})

it('renders a cheese change on the notice and the updated card without repeating unchanged details or an empty note', () => {
  const cheese = { id: 'cheese', name: 'Queso' }
  const queue: KdsQueue = {
    destinationId: 'kitchen', items: [{
      id: 'item', batchId: 'batch', batchSequence: 1, orderId: 'order', tableName: 'Mesa 7',
      quantity: 1, readyQuantity: 0, cancelledQuantity: 0, servedQuantity: 0,
      snapshot: { productName: 'Hamburguesa', variantName: 'Normal', lineModifiers: [cheese], note: null }, sentAt: '2026-10-28T19:00:00Z',
    }], events: [{
      id: 'event', event_type: 'modified', quantity: 1, created_at: '2026-10-28T19:01:00Z',
      payload: { tableName: 'Mesa 7', productName: 'Hamburguesa', variantName: 'Normal', lineModifiers: [cheese], note: null,
        previousState: { variantName: 'Normal', lineModifiers: [], note: null } },
    }],
  }
  useKdsQueue.mockReturnValue({ queue, error: null, refresh: vi.fn() })
  const html = renderToStaticMarkup(createElement(KdsPage, { context, isOnline: true, onLogout: async () => undefined }))
  const notice = html.slice(0, html.indexOf('aria-label="Tablero de producción"'))
  expect(notice).toContain('Añadido: Queso')
  expect(notice).not.toContain('Comentario:')
  expect(notice).not.toContain('sin comentario')
  expect(notice).not.toContain('Normal')
  expect(html).toContain('Normal · Queso')
})
