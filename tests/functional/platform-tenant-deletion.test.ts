import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createBillingDb, billingIds as ids } from '../helpers/billing-db.mjs'

const migration = readFileSync(new URL('../../supabase/migrations/20261101190202_allow_unused_tenant_billing_cleanup.sql', import.meta.url), 'utf8')

async function setup(after: (callback: () => Promise<void>) => void) {
  const { db } = await createBillingDb({ after })
  // Match the real tenant-owned catalog FKs; the billing fixture defaults to NO ACTION.
  await db.exec(`
    alter table venues drop constraint venues_tenant_id_fkey,
      add foreign key(tenant_id) references tenants(id) on delete cascade;
    alter table tenant_feature_assignments drop constraint tenant_feature_assignments_tenant_id_fkey,
      add foreign key(tenant_id) references tenants(id) on delete cascade;
    create table retained_history(tenant_id uuid references tenants(id));
  `)
  return db
}

it('reproduces the original FK failure for a seeded manual billing account', async () => {
  const db = await setup(onTestFinished)
  await expect(db.query('delete from tenants where id=$1', [ids.tenant])).rejects.toMatchObject({ code: '23503' })
  expect((await db.query('select * from billing_accounts where tenant_id=$1', [ids.tenant])).rows).toHaveLength(1)
})

describe('atomic tenant billing cleanup', () => {
  let db: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    db = await setup(afterAll)
    await db.exec(migration)
  })
  beforeEach(async () => { await db.exec('begin') })
  afterEach(async () => { await db.exec('rollback') })

  it('deletes an unused manual tenant and its account without affecting another tenant', async () => {
    await db.exec('set local role service_role')
    await db.query('delete from tenants where id=$1', [ids.tenant])
    expect((await db.query('select id from tenants')).rows).toEqual([{ id: ids.other }])
    expect((await db.query('select tenant_id from billing_accounts')).rows).toEqual([{ tenant_id: ids.other }])
    expect((await db.query('select * from venues')).rows).toHaveLength(0)
  })

  it('allows a pending onboarding draft before Stripe or billing activity exists', async () => {
    await db.exec('set local role service_role')
    await db.query("update billing_accounts set source='stripe',status='pending_payment',onboarding_contract='{}' where tenant_id=$1", [ids.tenant])
    await db.query('delete from tenants where id=$1', [ids.tenant])
    expect((await db.query('select * from billing_accounts where tenant_id=$1', [ids.tenant])).rows).toHaveLength(0)
  })

  it('preserves legacy tenants without a billing account', async () => {
    await db.query('delete from billing_accounts where tenant_id=$1', [ids.tenant])
    await db.query('delete from tenants where id=$1', [ids.tenant])
    expect((await db.query('select * from tenants where id=$1', [ids.tenant])).rows).toHaveLength(0)
  })

  it.each([
    "update billing_accounts set stripe_customer_id='cus_fixture' where tenant_id=$1",
    "update billing_accounts set stripe_subscription_id='sub_fixture' where tenant_id=$1",
    "update billing_accounts set contract='{}' where tenant_id=$1",
    "update billing_accounts set billed_contract='{}' where tenant_id=$1",
    "update billing_accounts set status='active' where tenant_id=$1",
    "update billing_accounts set sync_token=gen_random_uuid(),sync_until=now()+interval '1 minute' where tenant_id=$1",
    "insert into billing_audit(tenant_id,action,reason) values($1,'fixture','Keep history')",
    "insert into billing_invoices(stripe_invoice_id,tenant_id,status,currency,amount_due_cents,amount_paid_cents,created_at) values('in_fixture',$1,'paid','eur',100,100,now())",
    `insert into billing_operations(tenant_id,actor_id,kind,status,expected_revision,timing,preview,stripe_params,reason,proration_date,expires_at)
      values($1,'${ids.owner}','change','quoted',0,'immediate','{}','{}','Keep history',0,now())`,
  ])('blocks deletion with billing activity: %s', async (statement) => {
    await db.query(statement, [ids.tenant])
    await db.exec('savepoint deletion')
    await expect(db.query('delete from tenants where id=$1', [ids.tenant])).rejects.toMatchObject({ code: '23503', message: 'TENANT_BILLING_DELETE_BLOCKED' })
    await db.exec('rollback to savepoint deletion')
    expect((await db.query('select * from tenants where id=$1', [ids.tenant])).rows).toHaveLength(1)
    expect((await db.query('select * from billing_accounts where tenant_id=$1', [ids.tenant])).rows).toHaveLength(1)
  })

  it('rolls back billing cleanup and cascades when another protected relation blocks the delete', async () => {
    await db.query('insert into retained_history values($1)', [ids.tenant])
    await db.exec('savepoint deletion')
    await expect(db.query('delete from tenants where id=$1', [ids.tenant])).rejects.toMatchObject({ code: '23503' })
    await db.exec('rollback to savepoint deletion')
    expect((await db.query('select * from billing_accounts where tenant_id=$1', [ids.tenant])).rows).toHaveLength(1)
    expect((await db.query('select * from venues where tenant_id=$1', [ids.tenant])).rows).toHaveLength(2)
  })

  it('does not expose the internal helper to browser roles', async () => {
    const result = await db.query(`select has_function_privilege('anon','public.cleanup_unused_tenant_billing()','execute') anon,
      has_function_privilege('authenticated','public.cleanup_unused_tenant_billing()','execute') authenticated,
      has_function_privilege('service_role','public.cleanup_unused_tenant_billing()','execute') service`)
    expect(result.rows).toEqual([{ anon: false, authenticated: false, service: true }])
  })
})

