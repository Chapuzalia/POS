import { expect, it, onTestFinished } from 'vitest'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { onboardingContract } from '../../supabase/functions/_shared/billing/onboarding'
import { generateOwnerPassword, changeBillingPlan } from '../../src/features/billing/selection'
import { canAccessCrmSection } from '../../src/features/crm/routing/crmPermissions'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { BillingService } from '../../supabase/functions/_shared/billing/service'
import { StripeGateway } from '../../supabase/functions/_shared/billing/stripe'
import { compileComponent } from '../helpers/component-harness.mjs'
import { sendWelcomeEmail } from '../../supabase/functions/_shared/welcome-email'

const setup = () => createBillingService({ after: onTestFinished }, 4900)

it('creates Stripe tenants with a validated draft before returning success, preserves manual creation, and rolls back failed setup', async () => {
  const { db, selection, production } = await setup()
  const catalogRows = {
    billing_products: (await db.query('select * from billing_products')).rows,
    billing_price_versions: (await db.query('select * from billing_price_versions order by created_at desc')).rows,
    platform_features: (await db.query('select * from platform_features')).rows,
  }
  const schemas = compileComponent(readFileSync(new URL('../../supabase/functions/_shared/billing/schemas.ts', import.meta.url), 'utf8'), { 'npm:zod@4.4.3': { z } })
  const source = readFileSync(new URL('../../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')
  async function create(billingMode: 'manual' | 'stripe', failBilling = false, emailFailure = false) {
    const writes: Array<{ table: string; command: string; value: Record<string, unknown> }> = []
    const deletedUsers: string[] = []
    let ownerCreations = 0
    let emails = 0
    const client = {
      auth: {
        getUser: async () => ({ data: { user: { id: ids.owner } }, error: null }),
        admin: {
          createUser: async () => { ownerCreations++; return { data: { user: { id: ids.stranger } }, error: null } },
          deleteUser: async (id: string) => { deletedUsers.push(id); return { error: null } },
        },
      },
      from(table: string) {
        let value: Record<string, unknown> = {}
        let command = 'select'
        let single = false
        const filters: Record<string, unknown> = {}
        const rows = table === 'profiles' ? [{ id: ids.owner, is_superadmin: true }] : catalogRows[table as keyof typeof catalogRows] ?? []
        return {
          select() { return this }, order() { return this }, returns() { return this },
          eq(key: string, item: unknown) { filters[key] = item; return this },
          maybeSingle() { single = true; return this }, single() { single = true; return this },
          insert(input: Record<string, unknown>) { command = 'insert'; value = input; return this },
          upsert(input: Record<string, unknown>) { command = 'upsert'; value = input; return this },
          delete() { command = 'delete'; return this },
          then(resolve: (result: object) => void) {
            if (command !== 'select') writes.push({ table, command, value })
            const data = command === 'select' ? rows.filter((row: Record<string, unknown>) => Object.entries(filters).every(([key, item]) => row[key] === item)) : [{ id: crypto.randomUUID(), created_at: '2026-11-01T00:00:00Z', ...value }]
            return Promise.resolve(resolve({ data: single ? data[0] ?? null : data, error: table === 'billing_accounts' && command === 'insert' && failBilling ? new Error('fixture billing failure') : null }))
          },
        }
      },
    }
    let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 500 })
    compileComponent(source, {
      'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
      '../_shared/billing/service.ts': { BillingService }, '../_shared/billing/stripe.ts': { StripeGateway },
      '../_shared/platform-tenant-deletion.ts': {},
      '../_shared/billing/schemas.ts': schemas, '../_shared/billing/onboarding.ts': { onboardingContract },
      '../_shared/welcome-email.ts': { sendWelcomeEmail: (input: Parameters<typeof sendWelcomeEmail>[0], config: Parameters<typeof sendWelcomeEmail>[1]) => sendWelcomeEmail(input, config, async (_url, init) => {
        expect(writes.some(write => write.table === 'catalog_sale_formats')).toBe(true)
        expect(writes.some(write => write.table === 'tenant_memberships')).toBe(true)
        const message = JSON.parse(String(init?.body))
        if (billingMode === 'stripe') expect(message.template).toMatchObject({ id: '23a9523e-2c39-405f-8cf4-99dfa8ba8160', variables: { OWNER_NAME: 'Ana', BUSINESS_NAME: 'Café Aurora', USER_EMAIL: 'owner@example.test', INITIAL_PASSWORD: 'ABCDEFG2', LOGIN_URL: 'http://localhost:5173/crm' } })
        else { expect(message).not.toHaveProperty('template'); expect(message.html).toContain('Ya puedes iniciar sesión') }
        emails++
        return emailFailure ? Response.json({ message: 'unauthorized' }, { status: 401 }) : Response.json({ id: 'email-fixture' })
      }) },
    }, {
      Deno: { serve: (callback: typeof handler) => { handler = callback }, env: { get: (name: string) => name === 'STRIPE_TEST_SECRET_KEY' ? 'sk_test_fixture' : 'http://localhost:5173' } },
      Response, crypto, console: { error() {} },
    })
    const reply = await handler(new Request('http://localhost', { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: JSON.stringify({
      action: 'platform-create-tenant', tenantName: 'Café Aurora', tenantSlug: 'aurora', venueName: 'Sala principal', ownerEmail: 'owner@example.test', ownerPassword: 'ABCDEFG2', ownerFullName: 'Ana',
      billingMode, maxVenues: billingMode === 'manual' ? 2 : -1, maxDevices: 4,
      billingSelection: { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [], deviceIds: [] }] },
    }) }))
    return { reply, writes, ownerCreations, deletedUsers, emails }
  }
  const stripe = await create('stripe')
  expect(stripe.reply.status).toBe(201)
  expect((await stripe.reply.json()).welcomeEmailStatus).toBe('sent')
  expect(stripe.emails).toBe(1)
  expect(stripe.ownerCreations).toBe(1)
  expect(stripe.writes.find(write => write.table === 'tenants')?.value).toMatchObject({ billing_activation_required: true, max_venues: 3, max_devices: 5 })
  const venueId = stripe.writes.find(write => write.table === 'venues')?.value.id
  expect(stripe.writes.find(write => write.table === 'billing_accounts')?.value).toMatchObject({ source: 'stripe', status: 'pending_payment', email: 'owner@example.test', onboarding_contract: { recurringCents: 5900, addons: [{ venueIds: [venueId] }] } })
  const manual = await create('manual')
  expect(manual.reply.status).toBe(201)
  expect(manual.emails).toBe(1)
  expect(manual.writes.some(write => write.table === 'billing_accounts')).toBe(false)
  expect(manual.writes.find(write => write.table === 'tenants')?.value).toMatchObject({ max_venues: 2, max_devices: 4 })
  expect(manual.writes.find(write => write.table === 'tenants')?.value).not.toHaveProperty('billing_activation_required')
  const failed = await create('stripe', true)
  expect(failed.reply.status).toBe(500)
  expect(failed.emails).toBe(0)
  expect(failed.deletedUsers).toEqual([ids.stranger])
  expect(failed.writes.filter(write => write.command === 'delete').map(write => write.table)).toEqual(['billing_accounts', 'tenants'])
  const emailFailed = await create('stripe', false, true)
  expect(emailFailed.reply.status).toBe(201)
  expect((await emailFailed.reply.json()).welcomeEmailStatus).toBe('failed')
  expect(emailFailed.deletedUsers).toEqual([])
  expect(emailFailed.writes.filter(write => write.command === 'delete')).toEqual([])
})

it('generates eight-character passwords using unambiguous random characters', () => {
  const generated = new Set(Array.from({ length: 100 }, generateOwnerPassword))
  expect(generated.size).toBe(100)
  for (const password of generated) expect(password).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
})

it('limits pending owners to Mi Plan even with every feature enabled', () => {
  expect(canAccessCrmSection('owner', 'plan', [], undefined, true)).toBe(true)
  for (const section of ['dashboard', 'access', 'products', 'reports', 'settings', 'tables'] as const) expect(canAccessCrmSection('owner', section, ['restaurant'], undefined, true)).toBe(false)
  expect(canAccessCrmSection('manager', 'plan', [], undefined, true)).toBe(false)
  expect(canAccessCrmSection('owner', 'dashboard')).toBe(true)
})

it('prepares plan and extras without contacting Stripe and assigns the first venue', async () => {
  const { service, stripe, selection, production } = await setup()
  const contract = onboardingContract(await service.catalog(), { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [], deviceIds: [] }] }, ids.venue)
  expect(contract.recurringCents).toBe(5900)
  expect(contract.addons[0].venueIds).toEqual([ids.venue])
  expect(stripe.calls).toHaveLength(0)
  expect(() => onboardingContract({ products: [], versions: [] }, selection, ids.venue)).toThrow()
  expect(() => onboardingContract({ products: [], versions: [] }, { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venueB], deviceIds: [] }] }, ids.venue)).toThrow()
})

it('keeps a Stripe tenant gated through Checkout and failed payment, then unlocks only on paid reconciliation', async () => {
  const { service, stripe, db, selection } = await setup()
  await db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  await service.account(ids.tenant)
  await db.query("update billing_accounts set source='stripe',status='pending_payment' where tenant_id=$1", [ids.tenant])
  await service.saveOnboarding(ids.tenant, selection)
  expect((await service.detail(ids.tenant, false)).account.onboarding_contract.planName).toBe('Synthetic base')
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Activar')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const required = async () => (await db.query('select billing_activation_required pending from tenants where id=$1', [ids.tenant])).rows[0].pending
  expect(await required()).toBe(true)
  stripe.completeCheckout(false)
  await service.reconcile(ids.tenant)
  expect(await required()).toBe(true)
  stripe.pay()
  await service.reconcile(ids.tenant)
  expect(await required()).toBe(false)
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
})

it('does not unlock a trial without payment and leaves existing manual businesses active', async () => {
  const { service, stripe, db, selection } = await setup()
  await db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Activar')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout(false)
  stripe.subscriptions[0].status = 'trialing'
  await service.reconcile(ids.tenant)
  const tenants = await db.query('select id,billing_activation_required pending from tenants order by id')
  expect(tenants.rows).toEqual([{ id: ids.tenant, pending: true }, { id: ids.other, pending: false }])
})

it('expires the old Checkout before allowing plan changes and prevents edits while payment is processing', async () => {
  const { service, stripe, db, selection, production } = await setup()
  await db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  await service.account(ids.tenant)
  await service.saveOnboarding(ids.tenant, selection)
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Activar')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  await expect(service.saveOnboarding(ids.tenant, selection)).rejects.toThrow('BILLING_PENDING_CHANGE')
  await service.restartCheckout(ids.tenant)
  expect([...stripe.sessions.values()][0].status).toBe('expired')
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('expired')
  const updated = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  await service.saveOnboarding(ids.tenant, updated)
  const second = await service.quote(ids.tenant, ids.owner, updated, null, 'Cambiar plan')
  expect(second.contract.recurringCents).toBe(5900)
  await service.confirm(ids.tenant, ids.owner, second.id)
  const session = [...stripe.sessions.values()].at(-1)
  session.status = 'complete'
  await expect(service.restartCheckout(ids.tenant)).rejects.toThrow('BILLING_PENDING_CHANGE')
  expect((await db.query('select status from billing_operations where id=$1', [second.id])).rows[0].status).toBe('payment_pending')
})

it('invalidates previous quotes on draft edit and rejects foreign assignments and inactive tenants for edits', async () => {
  const { service, db, selection, production } = await setup()
  await db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Oferta inicial')
  await service.saveOnboarding(ids.tenant, selection)
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE')
  await expect(service.saveOnboarding(ids.tenant, { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.other], deviceIds: [] }] })).rejects.toThrow('BILLING_FOREIGN_ASSIGNMENT')
  await service.account(ids.other)
  await expect(service.saveOnboarding(ids.other, selection)).rejects.toThrow('BILLING_PENDING_CHANGE')
})

it('enforces pending access in PostgreSQL and prevents self activation or cross-tenant access', async () => {
  const { db } = await setup()
  await db.exec(`grant select on venues,tenants to authenticated;
    grant update(billing_activation_required) on tenants to authenticated;`)
  await db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  await db.exec(`set role authenticated; set "test.uid"='${ids.owner}';`)
  expect((await db.query('select public.get_current_billing_access($1) pending', [ids.tenant])).rows[0].pending).toBe(true)
  expect((await db.query('select public.user_is_tenant_admin($1) allowed', [ids.tenant])).rows[0].allowed).toBe(false)
  expect((await db.query('select public.user_has_tenant_role($1,array[\'owner\']) allowed', [ids.tenant])).rows[0].allowed).toBe(false)
  expect((await db.query('select * from venues')).rows).toEqual([])
  await expect(db.query('select public.get_current_billing_access($1)', [ids.other])).rejects.toThrow('BILLING_FORBIDDEN')
  await expect(db.query('update tenants set billing_activation_required=false where id=$1', [ids.tenant])).rejects.toThrow('BILLING_FORBIDDEN')
  await expect(db.query('select public.billing_save_onboarding($1,$2)', [ids.tenant, '{}'])).rejects.toThrow('permission denied')
  await db.exec('reset role')
  await db.query('update tenants set billing_activation_required=false where id=$1', [ids.tenant])
  await db.exec(`set role authenticated`)
  expect((await db.query('select public.user_is_tenant_admin($1) allowed', [ids.tenant])).rows[0].allowed).toBe(true)
  expect((await db.query('select * from venues')).rows).toHaveLength(2)
})

it('keeps compatible extras when switching interval and removes unavailable tariffs', async () => {
  const { service, selection, production } = await setup()
  const catalog = await service.catalog()
  const yearly = { ...catalog.versions.find(row => row.id === selection.planVersionId), id: 'annual-plan', interval: 'year' as const }
  const updated = changeBillingPlan({ ...catalog, versions: [yearly, ...catalog.versions] }, { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }, yearly.id)
  expect(updated).toEqual({ planVersionId: yearly.id, addons: [] })
})
