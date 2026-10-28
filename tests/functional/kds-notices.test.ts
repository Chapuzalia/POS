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
