import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createBillingService, sepa } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'

afterEach(() => { vi.useRealTimers() })
const at = (date: string) => vi.setSystemTime(new Date(date))
const deviceA = '40000000-0000-4000-8000-000000000001'
const deviceB = '40000000-0000-4000-8000-000000000002'
const cashier = '50000000-0000-4000-8000-000000000001'
const noAccess = { deactivateVenueIds: [], deactivateDeviceIds: [], reactivateVenueIds: [] }

// Two active venues, one terminal each (the second one with a cashier), on a 3-venue plan.
async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-11-10T10:00:00Z')
  const fixture = await createBillingService({ after: onTestFinished }, 4900)
  const { db, transition, service } = fixture
  await db.query('insert into devices(id,tenant_id,venue_id,name) values($1,$3,$4,$5),($2,$3,$6,$7)', [deviceA, deviceB, ids.tenant, ids.venue, 'Barra', ids.venueB, 'Terraza'])
  await db.query('update venues set name=$2 where id=$1', [ids.venueB, 'Terraza'])
  await db.query('insert into device_user_assignments(tenant_id,user_id,venue_id,device_id) values($1,$2,$3,$4)', [ids.tenant, cashier, ids.venueB, deviceB])
  const small = await transition('catalog_save', { actorId: ids.owner, product: { key: 'solo', kind: 'plan', name: 'Solo', description: '', scope: 'tenant', featureKey: null, resource: null, active: true, sortOrder: 2 }, version: { interval: 'month', amountCents: 2900, features: ['restaurant'], limits: { venues: 1, devices: 5 }, included: {}, maximum: null, requires: [] }, reason: 'Test fixture' })
  await service.publish(small.id)
  await fixture.activate()
  const venue = async (id: string) => (await db.query('select is_active from venues where id=$1', [id])).rows[0].is_active
  const device = async (id: string) => (await db.query('select is_active from devices where id=$1', [id])).rows[0].is_active
  const assignment = async () => (await db.query('select is_active from device_user_assignments where device_id=$1', [deviceB])).rows[0].is_active
  const operation = async (id: string) => (await db.query('select * from billing_operations where id=$1', [id])).rows[0]
  return { ...fixture, small: { planVersionId: small.id, addons: [] }, venue, device, assignment, operation }
}

it('asks which venue to deactivate on a downgrade and switches it off with its TPV access at renewal', async () => {
  const { service, mollie, db, small, venue, device, assignment, operation } = await setup()
  at('2026-11-20T10:00:00Z')
  await expect(service.quote(ids.tenant, ids.owner, small, null, 'Bajar a Solo')).rejects.toThrow('BILLING_LIMIT_BELOW_USAGE')
  await expect(service.quote(ids.tenant, ids.owner, small, null, 'Bajar', false, { ...noAccess, deactivateVenueIds: ['30000000-0000-4000-8000-000000000099'] })).rejects.toThrow('BILLING_FOREIGN_ASSIGNMENT')
  const quote = await service.quote(ids.tenant, ids.owner, small, null, 'Bajar a Solo', false, { ...noAccess, deactivateVenueIds: [ids.venueB] })
  expect(quote).toMatchObject({ timing: 'period_end', preview: { amountDueCents: 0, effectiveAt: '2026-12-10T00:00:00.000Z', losses: ['Local «Terraza» y sus 1 terminal TPV: quedará inactivo (se conservan sus datos).'] } })
  expect(quote.contract.access).toEqual({ deactivateVenueIds: [ids.venueB], deactivateDeviceIds: [deviceB], reactivateVenueIds: [], reactivateDeviceIds: [] })
  await service.confirm(ids.tenant, ids.owner, quote.id, false, { acceptLosses: true })
  // Until renewal everything keeps working.
  expect([await venue(ids.venueB), await device(deviceB), await assignment()]).toEqual([true, true, true])

  // An open shift defers the reduction; nothing is closed or switched off underneath it.
  at('2026-12-10T06:00:00Z')
  await db.query("insert into cash_sessions(id,tenant_id,status) values('60000000-0000-4000-8000-000000000001',$1,'open')", [ids.tenant])
  const renewal = mollie.renew('pending')
  await service.handleWebhook(renewal.id)
  expect(await venue(ids.venueB)).toBe(true)
  expect((await operation(quote.id)).status).toBe('scheduled')

  await db.query("update cash_sessions set status='closed'")
  await service.reconcile(ids.tenant)
  expect([await venue(ids.venueB), await device(deviceB), await assignment()]).toEqual([false, false, false])
  expect([await venue(ids.venue), await device(deviceA)]).toEqual([true, true])
  expect((await operation(quote.id)).status).toBe('completed')
  expect((await db.query('select max_venues from tenants where id=$1', [ids.tenant])).rows[0].max_venues).toBe(1)
  // The venue stays in the account (inactive) and cannot be switched back on outside a plan change.
  expect((await db.query('select count(*)::int n from venues where tenant_id=$1', [ids.tenant])).rows[0].n).toBe(2)
  await expect(db.query('update venues set is_active=true where id=$1', [ids.venueB])).rejects.toThrow('límite de locales')
})

it('reactivates a venue chosen in an upgrade, with the terminals billing switched off, once the card is paid', async () => {
  const { service, mollie, base, small, venue, device, assignment, selection } = await setup()
  at('2026-11-20T10:00:00Z')
  const down = await service.quote(ids.tenant, ids.owner, small, null, 'Bajar', false, { ...noAccess, deactivateVenueIds: [ids.venueB] })
  await service.confirm(ids.tenant, ids.owner, down.id, false, { acceptLosses: true })
  at('2026-12-10T06:00:00Z')
  mollie.settle(mollie.renew('pending'))
  await service.reconcile(ids.tenant)
  expect(await venue(ids.venueB)).toBe(false)

  at('2026-12-25T00:00:00Z')
  // More venues than slots: a reactivation that does not fit is rejected.
  await expect(service.quote(ids.tenant, ids.owner, small, null, 'Reactivar', false, { ...noAccess, reactivateVenueIds: [ids.venueB] })).rejects.toThrow('BILLING_LIMIT_BELOW_USAGE')
  const up = await service.quote(ids.tenant, ids.owner, { ...selection, planVersionId: base.id }, null, 'Volver al plan base', false, { ...noAccess, reactivateVenueIds: [ids.venueB] })
  expect(up.timing).toBe('immediate')
  expect(up.contract.access).toMatchObject({ reactivateVenueIds: [ids.venueB], reactivateDeviceIds: [deviceB] })
  const confirmed = await service.confirm(ids.tenant, ids.owner, up.id)
  expect(confirmed.url).toContain('checkout')
  expect(await venue(ids.venueB)).toBe(false)
  const charge = mollie.settle(mollie.payment('proration'))
  await service.handleWebhook(charge.id)
  expect([await venue(ids.venueB), await device(deviceB), await assignment()]).toEqual([true, true, true])
})

it('changes the direct-debit IBAN for the renewals and revokes the previous mandate', async () => {
  const { service, mollie, db } = await setup()
  const subscription = mollie.subscriptions[0]
  const previous = subscription.mandateId
  const card = mollie.mandates.find(row => row.method === 'creditcard')
  const requestId = '70000000-0000-4000-8000-000000000001'
  await expect(service.changeMandate(ids.tenant, requestId, { ...sepa, accountHolder: 'Nuevo Titular', iban: 'ES91 2100 0418 4502 0005 1333' }, ids.owner)).rejects.toThrow('BILLING_INVALID_IBAN')
  const result = await service.changeMandate(ids.tenant, requestId, { ...sepa, accountHolder: 'Nuevo Titular', iban: 'DE89 3704 0044 0532 0130 00' }, ids.owner)
  expect(result.last4).toBe('3000')
  expect(subscription.mandateId).toBe(result.mandateId)
  expect(mollie.mandates.find(row => row.id === previous)?.status).toBe('invalid')
  expect(card?.status).toBe('valid')
  // A repeated click reuses the same mandate.
  await service.changeMandate(ids.tenant, requestId, { ...sepa, accountHolder: 'Nuevo Titular', iban: 'DE89 3704 0044 0532 0130 00' }, ids.owner)
  expect(mollie.mandates.filter(row => row.method === 'directdebit' && row.status === 'valid')).toHaveLength(1)
  await expect(service.changeMandate(ids.tenant, requestId, { ...sepa, accountHolder: 'Otro titular' }, ids.owner)).rejects.toThrow('BILLING_STALE')
  expect((await service.detail(ids.tenant, false)).paymentMethod).toEqual({ method: 'directdebit', status: 'valid', last4: '3000' })
  const audit = (await db.query("select details from billing_audit where action='mandate'")).rows
  expect(JSON.stringify(audit)).not.toContain('DE89')
  // A debit the bank has accepted must settle before the account changes.
  at('2026-12-10T06:00:00Z')
  const renewal = mollie.renew('pending')
  await service.handleWebhook(renewal.id)
  await expect(service.changeMandate(ids.tenant, '70000000-0000-4000-8000-000000000002', { ...sepa, iban: sepa.iban }, ids.owner)).rejects.toThrow('BILLING_PENDING_CHANGE')
})
