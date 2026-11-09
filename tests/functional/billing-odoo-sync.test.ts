import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'

afterEach(() => { vi.useRealTimers() })

async function setup(options = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T10:00:00Z'))
  return createBillingService({ after: onTestFinished }, 4900, options)
}

it('keeps Odoo documents private to the service role', async () => {
  const { db, activate } = await setup()
  await activate()
  const [{ stripe_invoice_id: paymentId }] = (await db.query('select stripe_invoice_id from billing_invoices')).rows as { stripe_invoice_id: string }[]
  await expect(db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'bogus')`, [paymentId, ids.tenant])).rejects.toThrow(/check/)
  await db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'proforma')`, [paymentId, ids.tenant])
  // Supabase grants table privileges to authenticated by default; RLS must still hide every row.
  await db.exec(`grant select, insert, update on billing_odoo_documents to authenticated; set test.uid = '${ids.owner}'; set role authenticated`)
  try {
    expect((await db.query('select * from billing_odoo_documents')).rows).toEqual([])
    await expect(db.query(`update billing_odoo_documents set state = 'invoiced'`)).resolves.toMatchObject({ affectedRows: 0 })
    await expect(db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'proforma')`, [paymentId, ids.tenant])).rejects.toThrow(/row-level security/)
    await expect(db.query('select odoo_partner_id from billing_accounts')).resolves.toBeTruthy()
  } finally { await db.exec('reset role') }
})
