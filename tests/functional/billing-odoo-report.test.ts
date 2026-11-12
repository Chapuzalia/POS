import { expect, it } from 'vitest'
import { configureOdooBillingReport } from '../../scripts/configure-odoo-billing-report.mjs'

type Row = Record<string, unknown> & { id: number }
type Params = { domain?: Array<[string, string, unknown]>; ids?: number[]; vals?: Record<string, unknown>; vals_list?: Record<string, unknown>[] }
function gateway() {
  const tables: Record<string, Row[]> = { 'ir.ui.view': [{ id: 1, key: 'account.report_invoice_document', arch_db: 'Original template' }], 'ir.actions.report': [] }
  const calls: string[] = []
  let sequence = 1
  return { tables, calls, async call(model: string, method: string, params: Params) {
    calls.push(method)
    if (method === 'search_read') return tables[model].filter(row => params.domain?.every(([key, , value]) => row[key] === value)).map(row => ({ id: row.id }))
    if (method === 'create') return params.vals_list?.map(vals => { const id = ++sequence; tables[model].push({ id, ...vals }); return id })
    if (method === 'write') { for (const row of tables[model].filter(row => params.ids?.includes(row.id))) Object.assign(row, params.vals); return true }
    throw new Error('Unexpected method')
  } }
}

it('prepares the Odoo report configuration without writes by default', async () => {
  const odoo = gateway()
  expect(await configureOdooBillingReport(odoo)).toMatchObject({ applied: false, records: [{ action: 'create' }, { action: 'create' }, { action: 'create' }] })
  expect(odoo.calls.every(method => method === 'search_read')).toBe(true)
  expect(odoo.tables['ir.ui.view']).toHaveLength(1)
})

it('configures a separate report idempotently while preserving the standard template', async () => {
  const odoo = gateway()
  await configureOdooBillingReport(odoo, true)
  await configureOdooBillingReport(odoo, true)
  expect(odoo.tables['ir.ui.view']).toHaveLength(3)
  expect(odoo.tables['ir.actions.report']).toHaveLength(1)
  expect(odoo.tables['ir.ui.view'][0]).toEqual({ id: 1, key: 'account.report_invoice_document', arch_db: 'Original template' })
  expect(odoo.tables['ir.ui.view'][1]).toMatchObject({ mode: 'primary', inherit_id: 1 })
})

it('rejects ambiguous report configuration before writing', async () => {
  const odoo = gateway()
  odoo.tables['ir.ui.view'].push({ id: 9, key: 'account.report_invoice_document' })
  await expect(configureOdooBillingReport(odoo, true)).rejects.toThrow('ODOO_DUPLICATE_REPORT_CONFIGURATION')
  expect(odoo.calls).not.toContain('write')
  expect(odoo.calls).not.toContain('create')
})
