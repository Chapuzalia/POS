import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { OdooGateway } from '../supabase/functions/_shared/billing/odoo.ts'
import { ODOO_INVOICE_REPORT_NAME } from '../supabase/functions/_shared/billing/odoo-sync.ts'

// Dry-run by default. Applying this changes Odoo configuration and requires production approval.
export async function configureOdooBillingReport(odoo, apply = false) {
  const find = async (model, domain) => {
    const rows = await odoo.call(model, 'search_read', { domain, fields: ['id'], limit: 2 })
    if (rows.length > 1) throw new Error('ODOO_DUPLICATE_REPORT_CONFIGURATION')
    return rows[0]?.id
  }
  const base = await find('ir.ui.view', [['key', '=', 'account.report_invoice_document']])
  if (!base) throw new Error('ODOO_INVOICE_TEMPLATE_MISSING')
  const document = await readFile(new URL('./odoo/subscription-invoice-document.xml', import.meta.url), 'utf8')
  const wrapper = await readFile(new URL('./odoo/subscription-invoice-report.xml', import.meta.url), 'utf8')
  const records = [
    ['ir.ui.view', 'key', { key: `${ODOO_INVOICE_REPORT_NAME}_document`, name: 'Tickit subscription invoice document', type: 'qweb', inherit_id: base, mode: 'primary', arch_db: document }],
    ['ir.ui.view', 'key', { key: ODOO_INVOICE_REPORT_NAME, name: 'Tickit subscription invoice', type: 'qweb', arch_db: wrapper }],
    ['ir.actions.report', 'report_name', { name: 'Factura de suscripción Tickit', model: 'account.move', report_type: 'qweb-pdf', report_name: ODOO_INVOICE_REPORT_NAME, is_invoice_report: true }],
  ]
  const result = []
  for (const [model, field, values] of records) {
    const id = await find(model, [[field, '=', values[field]]])
    result.push({ model, key: values[field], action: id ? 'update' : 'create' })
    if (!apply) continue
    if (id) await odoo.call(model, 'write', { ids: [id], vals: values })
    else await odoo.call(model, 'create', { vals_list: [values] })
  }
  return { applied: apply, records: result }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Use --apply only after approval')
    const { ODOO_URL, ODOO_DB, ODOO_API_KEY } = process.env
    if (!ODOO_URL || !ODOO_DB || !ODOO_API_KEY) throw new Error('ODOO_CONFIGURATION_REQUIRED')
    console.log(JSON.stringify(await configureOdooBillingReport(new OdooGateway(ODOO_URL, ODOO_DB, ODOO_API_KEY), process.argv.includes('--apply'))))
  } catch {
    console.error('No se pudo configurar el informe de Odoo. Revisa credenciales, permisos y la plantilla base.')
    process.exitCode = 1
  }
}
