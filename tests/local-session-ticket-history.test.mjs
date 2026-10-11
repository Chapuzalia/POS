import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent } from './helpers/component-harness.mjs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const { createLocalSessionTicketHistoryPage } = compileComponent(read('../src/features/cash-registers/services/sessionTicketHistoryModel.ts'), {})
const ctx = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device' }
const session = { id: 'cash', cashRegisterId: 'register' }
function payload(i) {
  return { ticket: { id: `ticket-${i}`, ticketNumber: i, tenantId: 'tenant', venueId: 'venue', deviceId: 'device', cashSessionId: 'cash', cashRegisterId: 'register' },
    sale: { id: `sale-${i}`, totalCents: 240, createdAt: `2026-10-11T10:${String(i).padStart(2,'0')}:00Z`, paymentMethod: 'cash' },
    lines: [{ productName: 'Café', variantName: 'Grande', components: [{ productName: 'Leche', variantName: 'Avena' }] }] }
}
function record(i) {
  const p = payload(i)
  return { id: p.sale.id, payload: p, cashSessionId: 'cash', createdAt: p.sale.createdAt, totalCents: 240, ticketNumber: i, paymentMethod: 'cash', status: 'active' }
}

test('offline history paginates every local ticket and searches historical products, amount, fiscal number and IDs', () => {
  const tickets = Array.from({length: 25}, (_, i) => record(i + 1))
  const first = createLocalSessionTicketHistoryPage(tickets, 1, '')
  const second = createLocalSessionTicketHistoryPage(tickets, 2, '')
  const last = createLocalSessionTicketHistoryPage(tickets, 3, '')
  assert.equal(first.totalResults, 25)
  assert.deepEqual([first.tickets.length, second.tickets.length, last.tickets.length], [12,12,1])
  assert.equal(new Set([...first.tickets,...second.tickets,...last.tickets].map(item=>item.ticket.id)).size,25)
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 99, 'cafe').currentPage, 3)
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 1, '2,40 €').totalResults, 25)
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 1, 'avena').totalResults, 25)
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 1, 'ticket 25').totalResults, 1)
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 1, 'ticket-25').tickets[0].ticket.id, 'sale-25')
  tickets[0].payload.localFiscal = { series: 'NIC-C1', number: 100 }
  assert.equal(createLocalSessionTicketHistoryPage(tickets, 1, 'NIC-C1/100').totalResults, 1)
  assert.equal(createLocalSessionTicketHistoryPage([], 2, '').totalResults, 0)
})

test('synced SIF snapshots recover missing cache tickets, isolate scopes and preserve later payment/print state', async () => {
  const entries = [1,2,3,4,5].map(i=>({id:`record-${i}`, invoice:{ticketId:`ticket-${i}`}, record:{deviceId:i===5?'foreign-device':'device'}, delivery:{state:'AEAT_ACCEPTED'}}))
  entries.push({id:'annulment-2',invoice:{ticketId:'ticket-2'},annulment:{},record:{deviceId:'device'}})
  const sales = [1,2,3,4,5].map(i=>({id:`record-${i}`,synced:true,payload:payload(i)}))
  sales[2].payload.ticket.tenantId = 'foreign-tenant'
  sales[3].payload.ticket.cashSessionId = 'foreign-session'
  const cached = record(1)
  cached.paymentMethod = 'card'; cached.payload.sale.paymentMethod = 'card'; cached.printStatus = 'printed'
  const snapshot = JSON.stringify({entries,sales})
  const { loadLocalSessionTickets, loadLocalSessionSales } = compileComponent(read('../src/features/cash-registers/services/localSessionTickets.ts'), {
    '../../../lib/durableSales.ts': {loadDurableSessionTickets:async()=>[]},
    '../../../lib/offlineStore': {getSessionTickets:()=>[cached, {...record(10),cashSessionId:'other-session'}, {...record(11),payload:{...payload(11),ticket:{...payload(11).ticket,venueId:'foreign-venue'}}}]},
    '../../fiscal/local/localLedger.ts': {listLocalFiscalScopes:async (context, register)=>{assert.equal(context,ctx);assert.equal(register,'register');return [{installationId:'retired-installation'}]}, listLocalFiscalEntries:async()=>entries, listLocalFiscalEconomicSales:async()=>sales},
    '../../fiscal/local/posInvoice.ts': {printPayloadWithLocalFiscal:(p,e)=>({...p,localFiscal:{recordId:e.id}})},
  })
  const tickets = await loadLocalSessionTickets(ctx,session,[])
  assert.deepEqual(Array.from(tickets,t=>t.id),['sale-1','sale-2'])
  assert.equal(tickets[0].paymentMethod,'card')
  assert.equal(tickets[0].printStatus,'printed')
  assert.equal(tickets[1].status,'voided')
  assert.equal(tickets[1].payload.localFiscal.recordId,'record-2')
  const ledger = await loadLocalSessionSales(ctx,session)
  assert.deepEqual(Array.from(ledger,sale=>sale.id),['sale-1'])
  assert.equal(ledger[0].paymentMethod,'card')
  assert.equal(JSON.stringify({entries,sales}),snapshot)
})

test('offline cash totals recover a durable sale when every localStorage ticket cache is missing', async () => {
  const { loadLocalSessionSales } = compileComponent(read('../src/features/cash-registers/services/localSessionTickets.ts'), {
    '../../../lib/durableSales.ts': {loadDurableSessionTickets:async()=>[record(1)]},
    '../../../lib/offlineStore': {getSessionTickets:()=>[]},
    '../../fiscal/local/localLedger.ts': {listLocalFiscalScopes:async()=>[]},
    '../../fiscal/local/posInvoice.ts': {},
  })
  const ledger = await loadLocalSessionSales(ctx,session)
  assert.equal(ledger.length,1)
  assert.equal(ledger[0].id,'sale-1')
  assert.equal(ledger[0].totalCents,record(1).totalCents)
  assert.equal(ledger[0].cashSessionId,session.id)
})
