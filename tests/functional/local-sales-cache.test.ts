import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getSaleLedger, saveSaleLedger, clearSaleLedger, getSessionTickets, saveSessionTickets, clearSessionTickets } from '../../src/lib/offlineStore.ts'
import type { SaleRecord, SessionTicketRecord, TenantContext } from '../../src/types'

vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError: vi.fn() }))
const context = { tenantId: 'tenant', deviceId: 'device' } as TenantContext
let values: Map<string, string>
let writes: string[]
let failWrite: boolean
const sale = (id: string): SaleRecord => ({ id, cashSessionId: 'session', totalCents: 1210,
  paymentMethod: 'card', createdAt: `2026-11-14T10:${id.padStart(2, '0')}:00Z` })
const ticket = (id: string): SessionTicketRecord => ({ ...sale(id), ticketNumber: Number(id), status: 'active',
  payload: { ticket: { id: `ticket-${id}`, tenantId: 'tenant', venueId: 'venue' }, lines: [{ productName: 'Servicio ficticio' }] } } as SessionTicketRecord)
const ledgerKey = 'clubpos:v1:ledger:tenant:device'
const ticketsKey = 'clubpos:v1:session-tickets:tenant:device:session'

beforeEach(() => {
  values = new Map(); writes = []; failWrite = false
  vi.stubGlobal('window', { location: { pathname: '/pos' }, localStorage: {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failWrite) throw new Error('QuotaExceeded'); writes.push(key); values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
})
afterEach(() => { vi.unstubAllGlobals() })

it('adds one sale and one complete ticket without serializing or writing existing history', () => {
  const ledger = [sale('1')], tickets = [ticket('1')]
  saveSaleLedger(context, ledger)
  saveSessionTickets(context, 'session', tickets)
  writes = []
  // Access to an old payload would prove the append is serializing history again.
  const untouched = vi.spyOn(JSON, 'stringify')
  saveSaleLedger(context, [...ledger, sale('2')], ledger)
  saveSessionTickets(context, 'session', [ticket('2'), ...tickets], tickets)
  expect(writes).toHaveLength(2)
  expect(untouched.mock.calls.map(([value]) => value.id)).toEqual(['2', '2'])
  expect(getSaleLedger(context).map(record => record.id)).toEqual(['1', '2'])
  expect(getSessionTickets(context, 'session').map(record => record.id)).toEqual(['2', '1'])
})

it('reads the old installed-PWA arrays and merges individual updates, removals and additions after reload', () => {
  values.set(ledgerKey, JSON.stringify([sale('1'), sale('2')]))
  values.set(ticketsKey, JSON.stringify([ticket('2'), ticket('1')]))
  const previous = getSessionTickets(context, 'session')
  saveSessionTickets(context, 'session', [{ ...previous[0], printStatus: 'printed', printAttempts: 1 }, ticket('3')], previous)
  saveSaleLedger(context, [sale('2'), sale('3')])
  expect(getSaleLedger(context).map(record => record.id)).toEqual(['2', '3'])
  expect(getSessionTickets(context, 'session')).toMatchObject([{ id: '3' }, { id: '2', printStatus: 'printed', printAttempts: 1 }])
  expect(JSON.parse(values.get(ticketsKey) ?? 'null')).toHaveLength(2)
  expect(getSessionTickets({ ...context, tenantId: 'other' }, 'session')).toEqual([])
  expect(getSessionTickets({ ...context, deviceId: 'other' }, 'session')).toEqual([])
  expect(getSessionTickets(context, 'other')).toEqual([])
})

it('persists only the updated printing state and retains the economic snapshot', () => {
  const tickets = [ticket('2'), ticket('1')]
  saveSessionTickets(context, 'session', tickets)
  writes = []
  const next = [{ ...tickets[0], printStatus: 'printed' as const, printAttempts: 1 }, tickets[1]]
  saveSessionTickets(context, 'session', next, tickets)
  expect(writes).toEqual([`${ticketsKey}:record:v1:2`])
  expect(getSessionTickets(context, 'session')).toEqual(next)
})

it('does not rewrite unchanged records returned as new objects by a server refresh', () => {
  values.set(ticketsKey, JSON.stringify([ticket('2'), ticket('1')]))
  saveSessionTickets(context, 'session', [ticket('3'), ticket('2'), ticket('1')])
  expect(writes).toEqual([`${ticketsKey}:record:v1:3`])
  writes = []
  saveSessionTickets(context, 'session', [ticket('3'), ticket('2'), ticket('1')])
  expect(writes).toEqual([])
})

it('reports write failure and can retry the same append without losing the existing record', () => {
  const previous = [sale('1')], next = [...previous, sale('2')]
  saveSaleLedger(context, previous)
  failWrite = true
  expect(() => saveSaleLedger(context, next, previous)).toThrow('QuotaExceeded')
  failWrite = false
  saveSaleLedger(context, next)
  expect(getSaleLedger(context)).toEqual(next)
})

it('clears legacy arrays and individual records only for the requested scope', () => {
  values.set(ledgerKey, JSON.stringify([sale('1')]))
  values.set(ticketsKey, JSON.stringify([ticket('1')]))
  saveSaleLedger(context, [sale('1'), sale('2')])
  saveSessionTickets(context, 'session', [ticket('2'), ticket('1')])
  saveSessionTickets(context, 'other-session', [ticket('3')])
  clearSaleLedger(context)
  clearSessionTickets(context, 'session')
  expect(getSaleLedger(context)).toEqual([])
  expect(getSessionTickets(context, 'session')).toEqual([])
  expect(getSessionTickets(context, 'other-session')).toHaveLength(1)
})
