import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { createBillingService, sepa, payer, legal } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { billingLegalDocuments } from '../../supabase/functions/_shared/billing/legal'

it('blocks missing, partial and stale legal acceptance before creating anything at Mollie', async () => {
  const { service, db, mollie, selection } = await createBillingService({ after: onTestFinished })
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta SaaS')
  for (const input of [undefined, { ...legal, terms: false }, { ...legal, dpa: false }, { ...legal, businessRepresentative: false }]) {
    await expect(service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer, legal: input })).rejects.toThrow('BILLING_LEGAL_REQUIRED')
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer, legal: { ...legal, version: 'old' } })).rejects.toThrow('BILLING_LEGAL_VERSION')
  expect(mollie.calls).toHaveLength(0)
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('quoted')
  expect((await db.query('select * from billing_legal.acceptances')).rows).toHaveLength(0)
})

it('archives the real offer and acceptance once, independently from the payment and future profile changes', async () => {
  const { service, db, selection } = await createBillingService({ after: onTestFinished }, 4900)
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta SaaS')
  const result = await service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer, legal })
  expect(result.acceptance).toMatchObject({ operation_id: quote.id, tenant_id: ids.tenant, actor_id: ids.owner, receipt: {
    declarations: { terms: true, dpa: true, businessRepresentative: true },
    payer: { legalName: payer.legalName, taxId: payer.taxId }, contract: quote.contract,
    offer: { amountDueCents: 5929, recurringNetCents: 4900, recurringGrossCents: 5929, vatBasisPoints: 2100, automaticRenewal: true }, documents: billingLegalDocuments,
  } })
  expect(result.acceptance.accepted_at).toBeTruthy()
  expect(JSON.stringify(result.acceptance)).not.toContain(sepa.iban.replaceAll(' ', ''))
  expect(JSON.stringify(result.acceptance)).not.toContain('sessionReplay')
  const duplicate = await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(duplicate.acceptance).toEqual(result.acceptance)
  await service.saveProfile(ids.tenant, ids.owner, { ...payer, legalName: 'Otra razón social' })
  expect((await service.detail(ids.tenant, false)).legalAcceptances).toEqual([result.acceptance])
  expect((await db.query('select count(*)::int total from billing_legal.acceptances')).rows[0].total).toBe(1)
  expect(await service.legalAcceptance(ids.other, quote.id)).toBeNull()
})

it('rolls back the operation claim when evidence cannot be recorded and prevents admin retry from bypassing it', async () => {
  const { service, db, mollie, selection } = await createBillingService({ after: onTestFinished })
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta SaaS')
  await db.exec('alter table billing_legal.acceptances add constraint fixture_reject_evidence check (false)')
  await expect(service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer, legal })).rejects.toThrow('BILLING_LEGAL_REQUIRED')
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('quoted')
  expect(mollie.calls).toHaveLength(0)
  await db.query("update billing_operations set status='applying' where id=$1", [quote.id])
  await expect(service.confirm(ids.tenant, ids.owner, quote.id, true)).rejects.toThrow('BILLING_LEGAL_REQUIRED')
  expect(mollie.calls).toHaveLength(0)
})

it('enforces owner and tenant access and rejects forged evidence at the database boundary', async () => {
  const { service, db, selection } = await createBillingService({ after: onTestFinished })
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta SaaS')
  await expect(service.confirm(ids.tenant, ids.stranger, quote.id, false, { sepa, payer, legal })).rejects.toThrow('BILLING_LEGAL_REQUIRED')
  const result = await service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer, legal })
  await db.query("select set_config('test.uid',$1,false)", [ids.stranger])
  await db.exec('set role authenticated')
  expect((await db.query('select * from billing_legal.acceptances')).rows).toHaveLength(0)
  await expect(db.query('select billing_accept_contract($1,$2::jsonb)', [ids.tenant, '{}'])).rejects.toThrow(/permission denied/)
  await expect(db.query('insert into billing_legal.acceptances(operation_id,tenant_id,actor_id,receipt) values($1,$2,$3,$4)', [quote.id, ids.tenant, ids.stranger, '{}'])).rejects.toThrow(/permission denied/)
  await db.query("select set_config('test.uid',$1,false)", [ids.owner])
  expect((await db.query('select * from billing_legal.acceptances')).rows).toHaveLength(1)
  await db.exec('reset role; set role service_role')
  await expect(db.query("update billing_legal.acceptances set receipt='{}' where operation_id=$1", [quote.id])).rejects.toThrow(/permission denied/)
  await expect(db.query('delete from billing_legal.acceptances where operation_id=$1', [quote.id])).rejects.toThrow(/permission denied/)
  await db.exec('reset role')
  expect(await service.legalAcceptance(ids.tenant, quote.id)).toEqual(result.acceptance)
})

it('keeps the exact document bytes identified by every acceptance fingerprint available', () => {
  for (const doc of Object.values(billingLegalDocuments)) {
    const bytes = readFileSync(new URL(`../../public${doc.url}`, import.meta.url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(doc.sha256)
    expect(bytes.toString()).toContain('<html lang="es">')
    expect(bytes.toString()).not.toMatch(/borrador|copia Bruno|no publicado|Stripe/i)
  }
})
