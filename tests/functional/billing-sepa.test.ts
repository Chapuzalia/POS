import { createHash } from 'node:crypto'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createBillingService, legal, payer, sepa } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { mandateReference, noticeWindowOpen, sepaAuthorizationVersion } from '../../supabase/functions/_shared/billing/sepa'
import { sepaNoticeSender } from '../../supabase/functions/_shared/billing/sepa-notices'
import type { SepaNotice, SepaNoticeDelivery } from '../../supabase/functions/_shared/billing/sepa-notices'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function fixedTime(date = '2026-11-13T10:00:00Z') {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(date))
}

it('requires an explicit current mandate authorization before recording a contract or calling Mollie', async () => {
  const { service, db, mollie, selection } = await createBillingService({ after: onTestFinished })
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta')
  for (const authorization of [undefined, { accepted: false, version: sepaAuthorizationVersion }, { accepted: true, version: 'old' }]) {
    await expect(service.confirm(ids.tenant, ids.owner, quote.id, false, { legal, payer, sepa: { ...sepa, authorization } })).rejects.toThrow('BILLING_SEPA_AUTHORIZATION_REQUIRED')
  }
  expect(mollie.calls).toHaveLength(0)
  expect((await db.query('select * from billing_legal.acceptances')).rows).toHaveLength(0)
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('quoted')
})

it('archives a verifiable authorization bound to the owner, offered mandate and account without persisting the IBAN', async () => {
  fixedTime()
  const { service, db, mollie, selection } = await createBillingService({ after: onTestFinished })
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta')
  const result = await service.confirm(ids.tenant, ids.owner, quote.id, false, { legal, payer, sepa })
  const evidence = result.acceptance.receipt.sepa
  expect(evidence).toMatchObject({ accepted: true, actorId: ids.owner, tenantId: ids.tenant, reference: mandateReference(quote.id), ibanLast4: '1332', scheme: 'SEPA Core' })
  expect(evidence.preNotificationDays).toBe(3)
  const { sha256, ...signed } = evidence
  const canonical = JSON.stringify(signed, [...Object.keys(signed), ...Object.keys(signed.creditor)].sort())
  expect(sha256).toBe(createHash('sha256').update(canonical).digest('hex'))
  expect(evidence.ibanSha256).toBe(createHash('sha256').update(sepa.iban.replaceAll(' ', '')).digest('hex'))
  expect(JSON.stringify((await db.query('select receipt from billing_legal.acceptances')).rows)).not.toContain('ES91')
  expect(mollie.mandates.find(row => row.method === 'directdebit').mandateReference).toBe(evidence.reference)
  expect(mandateReference('70000000-0000-4000-8000-000000000001')).not.toBe(mandateReference('70000000-0000-4000-8000-000000000002'))
  expect(evidence.reference).toHaveLength(35)
})

it('sends and archives one timely notification for each actual renewal and reuses it on reconciliation', async () => {
  fixedTime()
  const delivered: SepaNotice[] = []
  const sender = vi.fn(async (notice: SepaNotice): Promise<SepaNoticeDelivery> => { delivered.push(notice); return { status: 'sent', messageId: `email-${delivered.length}` } })
  const { service, mollie, activate } = await createBillingService({ after: onTestFinished }, 4900, { sepaNotices: sender })
  await activate()
  expect(sender).toHaveBeenCalledTimes(1)
  expect(delivered[0]).toMatchObject({ recipient: payer.email, amountCents: 5929, dueDate: '2026-12-13', tenantId: ids.tenant })
  expect(delivered[0].preNotificationDays).toBe(3)
  expect((await service.reconcile(ids.tenant)).sepaWarning).toBeUndefined()
  expect(sender).toHaveBeenCalledTimes(1)
  vi.setSystemTime(new Date('2026-12-13T06:00:00Z'))
  await service.handleWebhook(mollie.renew('paid').id)
  expect(sender).toHaveBeenCalledTimes(2)
  expect(delivered[1].dueDate).toBe('2027-01-13')
  const history = (await service.detail(ids.tenant, false)).sepaRecords
  expect(history.filter(row => row.notice?.status === 'sent')).toHaveLength(2)
  expect(JSON.stringify(history)).not.toContain('ES91')
})

it('retains fourteen days for a mandate without evidence of an expressly agreed reduction', async () => {
  fixedTime()
  const { service, mollie, activate } = await createBillingService({ after: onTestFinished })
  await activate()
  const sub = mollie.subscriptions[0]
  expect(await service.sepaDaysForMandate(ids.tenant, sub.customerId, sub.mandateId)).toBe(3)
  const mandate = mollie.mandates.find(row => row.id === sub.mandateId)
  mandate.mandateReference = 'LEGACY-AUTHORIZATION'
  expect(await service.sepaDaysForMandate(ids.tenant, sub.customerId, sub.mandateId)).toBe(14)
})

it('does not resend an uncertain notification after its provider idempotency window', async () => {
  fixedTime()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const sender = vi.fn(async (): Promise<SepaNoticeDelivery> => ({ status: 'unknown' }))
  const { service, activate } = await createBillingService({ after: onTestFinished }, 4900, { sepaNotices: sender })
  await activate()
  await service.reconcile(ids.tenant)
  expect(sender).toHaveBeenCalledTimes(2)
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'))
  expect((await service.reconcile(ids.tenant)).sepaWarning).toBe('unknown')
  expect(sender).toHaveBeenCalledTimes(2)
  expect((await service.detail(ids.tenant, false)).account.status).toBe('active')
})

it('keeps paid access when notification fails and identifies a later delivery as late instead of claiming the agreed three days', async () => {
  fixedTime()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let available = false
  const sender = async (): Promise<SepaNoticeDelivery> => available ? { status: 'sent', messageId: 'delivered' } : { status: 'not_configured' }
  const { service, activate } = await createBillingService({ after: onTestFinished }, 4900, { sepaNotices: sender })
  await activate()
  expect((await service.detail(ids.tenant, false)).account.status).toBe('active')
  vi.setSystemTime(new Date('2026-12-11T10:00:00Z'))
  available = true
  expect((await service.reconcile(ids.tenant)).sepaWarning).toBe('late')
  const detail = await service.detail(ids.tenant, false)
  expect(detail.account.status).toBe('active')
  expect(detail.sepaRecords.some(row => row.notice?.status === 'late')).toBe(true)
})

it('enforces three agreed calendar days on a new bank-account authorization without changing the bank mandate', async () => {
  fixedTime()
  const { service, mollie, activate } = await createBillingService({ after: onTestFinished })
  await activate()
  vi.setSystemTime(new Date('2026-12-11T10:00:00Z'))
  const original = mollie.subscriptions[0].mandateId
  await expect(service.changeMandate(ids.tenant, '70000000-0000-4000-8000-000000000002', sepa, ids.owner)).rejects.toThrow('BILLING_SEPA_NOTICE_WINDOW')
  expect(mollie.subscriptions[0].mandateId).toBe(original)
  expect(noticeWindowOpen('2026-12-14', new Date(), 3)).toBe(true)
  expect(noticeWindowOpen('2026-12-13', new Date(), 3)).toBe(false)
  expect(noticeWindowOpen('2026-12-24')).toBe(false)
  expect(noticeWindowOpen('2026-12-25')).toBe(true)
  expect(noticeWindowOpen('invalid')).toBe(false)
})

it('sends only the announced amount, date and masked account with a stable key and no URL credentials', async () => {
  const calls: RequestInit[] = []
  const send = sepaNoticeSender({ apiKey: 'fixture-secret', appUrl: 'https://crm.example.test/base?secret=discard#x' }, async (_url, init) => { calls.push(init ?? {}); return Response.json({ id: 'email-notice' }) })
  const notice: SepaNotice = { key: 'fixture-key', tenantId: ids.tenant, subscriptionId: 'sub_fixture', mandateId: 'mdt_fixture', recipient: payer.email, amountCents: 5929, dueDate: '2026-12-13', reference: 'UMR-FIXTURE', ibanLast4: '1332', preNotificationDays: 3 }
  expect(await send(notice)).toEqual({ status: 'sent', messageId: 'email-notice' })
  const body = JSON.parse(String(calls[0].body))
  expect(body.to).toEqual([payer.email])
  expect(body.text).toContain('2026-12-13')
  expect(body.text).toContain('59,29')
  expect(body.text).toContain('1332')
  expect(body.text).not.toMatch(/fixture-secret|secret=discard|sub_fixture|mdt_fixture/)
  expect(new Headers(calls[0].headers).get('Idempotency-Key')).toBe('tickit:sepa-notice:fixture-key')
})

it('preserves a paid upgrade when its card settles after the notice deadline without silently increasing the unannounced debit', async () => {
  fixedTime()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { service, mollie, activate, selection, production } = await createBillingService({ after: onTestFinished }, 4900)
  await activate()
  const quote = await service.quote(ids.tenant, ids.owner, { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }, null, 'Ampliación')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  vi.setSystemTime(new Date('2026-12-12T10:00:00Z'))
  await service.handleWebhook(mollie.settle(mollie.payment('proration')).id)
  const detail = await service.detail(ids.tenant, false)
  expect(detail.account.status).toBe('active')
  expect(detail.account.contract.recurringCents).toBe(5900)
  expect(mollie.subscriptions[0].amount.value).toBe('59.29')
  expect(detail.sepaRecords.some(row => row.notice?.status === 'change_requires_notice')).toBe(true)
})
