import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openLedger, request, transactionDone } from '../../src/lib/localDatabase'

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => vi.unstubAllGlobals())

it('opens the existing database name and version with the shared fiscal and economic schema', async () => {
  const db = await openLedger()
  try {
    expect(db.name).toBe('tickit-verifactu-local-v1')
    expect(db.version).toBe(5)
    expect([...db.objectStoreNames]).toEqual([
      'bindings', 'cursors', 'delivery', 'durableEvents', 'durableSales',
      'economicSales', 'entries', 'numbers', 'paymentOperations', 'restaurantPayments',
    ])
    const tx = db.transaction([...db.objectStoreNames], 'readonly')
    const done = transactionDone(tx)
    expect(tx.objectStore('entries').index('ticket').keyPath).toEqual(['scope', 'invoice.ticketId'])
    for (const store of ['entries', 'economicSales', 'paymentOperations', 'durableSales']) {
      expect(tx.objectStore(store).index('scope').keyPath).toBe('scope')
    }
    expect(tx.objectStore('durableEvents').index('route').keyPath).toBe('route')
    expect(tx.objectStore('restaurantPayments').index('scope').keyPath).toBe('entry.scope')
    await done
  } finally { db.close() }
})

it('preserves pending fiscal records and payments while upgrading an older database', async () => {
  const opening = indexedDB.open('tickit-verifactu-local-v1', 4)
  opening.onupgradeneeded = () => {
    const db = opening.result
    db.createObjectStore('entries', { keyPath: 'id' }).put({ id: 'fiscal-record', scope: 'tenant:installation', invoice: { ticketId: 'ticket' } })
    db.createObjectStore('paymentOperations', { keyPath: 'key' }).put({ key: 'payment', scope: 'tenant:session', state: 'accepted' })
  }
  const previous = await request(opening)
  previous.close()
  const db = await openLedger()
  try {
    const tx = db.transaction(['entries', 'paymentOperations'], 'readonly')
    const done = transactionDone(tx)
    expect(await request(tx.objectStore('entries').index('ticket').get(['tenant:installation', 'ticket'])))
      .toEqual({ id: 'fiscal-record', scope: 'tenant:installation', invoice: { ticketId: 'ticket' } })
    expect(await request(tx.objectStore('paymentOperations').index('scope').get('tenant:session')))
      .toEqual({ key: 'payment', scope: 'tenant:session', state: 'accepted' })
    await done
  } finally { db.close() }
})

it('keeps the existing error when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  await expect(openLedger()).rejects.toThrow('IndexedDB no está disponible. No se puede expedir.')
})
