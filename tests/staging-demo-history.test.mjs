import test from 'node:test'
import assert from 'node:assert/strict'
import { accountDefinitions, buildRows, demoId, target } from '../scripts/staging-demo-data.mjs'
import { addDays, createHistoryPlan, historySessionSql, madridDate, madridIso } from '../scripts/staging-demo-history.mjs'
import { parseHistoryArgs } from '../scripts/seed-staging-demo-history.mjs'

const accounts = accountDefinitions().map(a => ({ ...a, id: demoId(`test-auth/${a.key}`) }))
const rows = buildRows(accounts)
const table = name => rows.filter(r => r.table === name).map(r => r.row)
const source = {
  venues: table('venues').map(v => ({ ...v, day_change_time: null })),
  products: table('products').map(p => {
    const variant = table('product_variants').find(v => v.product_id === p.id)
    const placement = table('catalog_placements').find(v => v.product_id === p.id)
    const category = table('categories').find(v => v.id === placement.category_id)
    const tab = table('catalog_tabs').find(v => v.id === placement.tab_id)
    const recipe = table('inventory_recipes').find(v => v.variant_id === variant.id)
    const line = recipe && table('inventory_recipe_lines').find(v => v.recipe_id === recipe.id)
    return { ...p, variant_id: variant.id, variant_name: variant.name, price_cents: variant.price_cents, category_id: category.id, category_name: category.name, tab_id: tab.id, tab_name: tab.label, inventory_item_id: line?.inventory_item_id ?? null, warehouse_id: line ? table('inventory_warehouses').find(w => w.venue_id === p.venue_id).id : null }
  }),
}
const asOf = new Date('2026-10-21T15:50:00Z')
const plan = createHistoryPlan(source, accounts, asOf)

test('history refuses production, accepts only a fixed staging target and freezes ninety Madrid dates', () => {
  assert.throws(() => parseHistoryArgs(['--apply', 'dbdtluvsdqycxl5tecuwljie']), /Destino fijo/)
  assert.throws(() => parseHistoryArgs(['--apply', target.project, '--host', 'production']), /Destino fijo/)
  assert.equal(parseHistoryArgs(['--apply', target.project]), '--apply')
  assert.equal(plan.startDate, '2026-07-24')
  assert.equal(plan.endDate, '2026-10-21')
  assert.equal(plan.sessions.length, 450)
  assert.equal(new Set(plan.sessions.map(s => s.id)).size, 450)
  for (const venue of source.venues) {
    const sessions = plan.sessions.filter(s => s.venueId === venue.id)
    assert.equal(sessions.length, 90)
    assert.equal(new Set(sessions.map(s => s.date)).size, 90)
    for (const s of sessions) {
      assert.equal(madridDate(new Date(s.openedAt)), s.date)
      assert.equal(madridDate(new Date(s.closedAt)), s.date)
      assert.ok(Date.parse(s.openedAt) < Date.parse(s.closedAt))
      assert.ok(Date.parse(s.closedAt) < asOf.getTime())
    }
  }
})

test('calendar arithmetic respects DST boundaries and calendar year changes', () => {
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(Date.parse(madridIso('2026-10-26')) - Date.parse(madridIso('2026-10-25')), 25 * 3_600_000)
  assert.equal(Date.parse(madridIso('2026-03-30')) - Date.parse(madridIso('2026-03-29')), 23 * 3_600_000)
})

test('all historical tickets, payments and closings conserve integer cents and tenant/device identity', () => {
  const ids = new Set()
  for (const session of plan.sessions) {
    let cash = 0
    let card = 0
    const consumptions = new Map()
    for (const event of session.events) {
      const { ticket, sale, payment, lines } = event.payload
      for (const id of [event.id, ticket.id, sale.id, payment.id, ...lines.map(l => l.id)]) {
        assert.ok(!ids.has(id), `Duplicate ${id}`)
        ids.add(id)
      }
      assert.equal(ticket.tenantId, session.tenantId)
      assert.equal(sale.venueId, session.venueId)
      assert.equal(sale.userId, session.actorId)
      assert.equal(sale.cashRegisterId, session.deviceId)
      assert.equal(sale.cashSessionId, session.id)
      assert.equal(sale.ticketId, ticket.id)
      assert.equal(payment.saleId, sale.id)
      assert.equal(payment.tenantId, session.tenantId)
      assert.equal(ticket.totalCents, sale.totalCents)
      assert.equal(sale.totalCents, payment.amountCents)
      assert.equal(ticket.subtotalCents, lines.reduce((n, l) => n + l.lineTotalCents, 0))
      assert.equal(ticket.totalCents, lines.reduce((n, l) => n + l.netTotalCents, 0))
      assert.equal(ticket.discountAmountCents, lines.reduce((n, l) => n + l.discountAmountCents, 0))
      assert.ok(Date.parse(ticket.createdAt) > Date.parse(session.openedAt) && Date.parse(ticket.createdAt) < Date.parse(session.closedAt))
      if (payment.method === 'cash') {
        cash += payment.amountCents
        assert.equal(payment.receivedCents - payment.changeCents, payment.amountCents)
      } else {
        card += payment.amountCents
        assert.equal(payment.receivedCents, null)
        assert.equal(payment.changeCents, 0)
      }
      for (const line of lines) {
        assert.equal(line.tenantId, session.tenantId)
        assert.equal(line.ticketId, ticket.id)
        for (const value of [line.unitPriceCents, line.lineTotalCents, line.netTotalCents, line.discountAmountCents]) assert.ok(Number.isSafeInteger(value))
        assert.equal(line.lineTotalCents, line.unitPriceCents * line.quantity)
        assert.equal(line.lineTotalCents - line.discountAmountCents, line.netTotalCents)
        assert.ok(line.catalogSnapshot.categoryId && line.catalogSnapshot.categoryName && line.catalogSnapshot.catalogTabId)
        const p = source.products.find(p => p.id === line.productId)
        assert.equal(p.tenant_id, session.tenantId)
        assert.equal(p.venue_id, session.venueId)
        if (p.inventory_item_id) consumptions.set(p.inventory_item_id, (consumptions.get(p.inventory_item_id) ?? 0) + line.quantity)
      }
    }
    assert.equal(session.totalCents, cash + card)
    assert.equal(session.expectedCashCents, 10000 + cash - session.withdrawal)
    assert.equal(session.expectedCardCents, card)
    assert.equal(session.countedCashCents - session.expectedCashCents, session.discrepancy)
    for (const r of session.replenishments) assert.equal(r.quantity, consumptions.get(r.itemId))
  }
})

test('today, previous months, payment types, weekend variation and group discounts have usable data', () => {
  const weekdayCounts = []
  const weekendCounts = []
  const payments = new Set()
  const months = new Set()
  let discounts = 0
  for (const s of plan.sessions) {
    const weekend = [0, 5, 6].includes(new Date(`${s.date}T12:00Z`).getUTCDay())
    ;(weekend ? weekendCounts : weekdayCounts).push(s.events.length)
    months.add(s.date.slice(0, 7))
    for (const e of s.events) {
      payments.add(e.payload.payment.method)
      discounts += e.payload.ticket.discountAmountCents
      if (e.payload.ticket.discount) assert.equal(s.tenantId, demoId('grupo'))
    }
  }
  assert.equal(plan.sessions.filter(s => s.date === plan.endDate).length, 5)
  assert.equal(months.size, 4)
  assert.deepEqual([...payments].sort(), ['card', 'cash'])
  assert.ok(discounts > 0)
  assert.ok(weekendCounts.reduce((a, b) => a + b, 0) / weekendCounts.length > weekdayCounts.reduce((a, b) => a + b, 0) / weekdayCounts.length)
})

test('the generator rejects incomplete catalogues and runs normal RPCs without disabling guards', () => {
  assert.throws(() => createHistoryPlan({ ...source, products: source.products.slice(1) }, accounts, asOf), /Catálogo demo incompleto/)
  const sql = historySessionSql(plan.sessions[0], { rollback: true })
  assert.match(sql, /sync_sale_created_v2/)
  assert.match(sql, /close_cash_register_session/)
  assert.match(sql, /DEMO_HISTORY_EXISTING_SESSION_MISMATCH/)
  assert.match(sql, /STAGING_DEMO_TARGET_REQUIRED/)
  assert.ok(sql.endsWith('rollback;'))
  assert.doesNotMatch(sql, /disable trigger|session_replication_role|app\.local_fiscal_sale|alter table|drop |password/i)
})
