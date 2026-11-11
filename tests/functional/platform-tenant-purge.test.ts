import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createBillingDb, billingIds as ids } from '../helpers/billing-db.mjs'
import { compileComponent } from '../helpers/component-harness.mjs'
import { MollieRequestError } from '../../supabase/functions/_shared/billing/mollie'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const purgeSql = read('supabase/migrations/20261101192516_add_platform_tenant_purge.sql')
const deletion = compileComponent(read('supabase/functions/_shared/platform-tenant-deletion.ts'), {
  'npm:zod@4.4.3': { z }, './billing/mollie.ts': { MollieRequestError },
})
const member = '20000000-0000-4000-8000-000000000003'

async function setup() {
  const { db } = await createBillingDb({ after: afterAll })
  await db.exec(`
    create table auth.users(id uuid primary key);
    insert into auth.users values('${ids.owner}'),('${ids.stranger}'),('${member}');
    alter table profiles add foreign key(id) references auth.users(id) on delete cascade;
    update profiles set is_superadmin=true where id='${ids.owner}';
    insert into profiles values('${member}',false);
    insert into tenant_memberships values('${ids.tenant}','${member}','owner',true);
    create schema storage;
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null);
    create table fiscal_subjects(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict);
    create table fiscal_sif_installations(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict,subject_id uuid references fiscal_subjects(id) on delete restrict);
    create table fiscal_local_records(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict,installation_id uuid references fiscal_sif_installations(id) on delete restrict);
    create table fiscal_bridge_requests(installation_id uuid references fiscal_sif_installations(id) on delete restrict);
    create table tickets(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict,sale_id uuid);
    create table sales(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict,ticket_id uuid references tickets(id) on delete restrict);
    alter table tickets add foreign key(sale_id) references sales(id) on delete restrict;
    create table production_batches(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict);
    create table production_items(id uuid primary key,tenant_id uuid references tenants(id) on delete restrict,batch_id uuid references production_batches(id) on delete restrict);
    create table reservations(id uuid primary key,tenant_id uuid references tenants(id));
    create table restaurant_tables(id uuid primary key,tenant_id uuid references tenants(id));
    create table product_modifier_group_assignments(id uuid primary key,tenant_id uuid,group_id uuid,is_active boolean,min_selection integer);
    create table modifiers(id uuid primary key,tenant_id uuid,group_id uuid,is_active boolean);
    create table legacy_children(id uuid primary key,tenant_id uuid references tenants(id) on delete cascade);
    insert into legacy_children values('${ids.other}','${ids.other}');
    grant usage on schema auth,storage to service_role;
    grant all on all tables in schema public,storage,auth to service_role;
    insert into fiscal_subjects values('${ids.venue}','${ids.tenant}');
    insert into fiscal_sif_installations values('${ids.venue}','${ids.tenant}','${ids.venue}');
    insert into fiscal_local_records values('${ids.venue}','${ids.tenant}','${ids.venue}');
    insert into fiscal_bridge_requests values('${ids.venue}');
    insert into tickets values('${ids.venue}','${ids.tenant}',null);
    insert into sales values('${ids.venue}','${ids.tenant}','${ids.venue}');
    update tickets set sale_id='${ids.venue}';
    insert into production_batches values('${ids.venue}','${ids.tenant}');
    insert into production_items values('${ids.venue}','${ids.tenant}','${ids.venue}');
    insert into reservations values('${ids.venue}','${ids.tenant}');
    insert into restaurant_tables values('${ids.venue}','${ids.tenant}');
    insert into modifiers values('${ids.venue}','${ids.tenant}','${ids.venue}',true);
  `)
  const baseline = read('supabase/0.Complete_Database_24-07-26.sql')
  const capacityStart = baseline.indexOf('CREATE FUNCTION public.validate_modifier_capacity()')
  await db.exec(baseline.slice(capacityStart,baseline.indexOf('$$;',capacityStart)+3))
  await db.exec('CREATE CONSTRAINT TRIGGER modifiers_capacity_guard AFTER INSERT OR DELETE OR UPDATE ON public.modifiers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_modifier_capacity()')
  // Use the actual private connector schema, intentionally without service-role table grants.
  const carta = read('supabase/migrations/20261017234914_tickit_carta_api.sql')
  await db.exec(carta.slice(carta.indexOf('create schema'),carta.indexOf('create function public.tickit_carta_configure')))
  await db.exec(`insert into tickit_private.integrations(id,tenant_id,venue_id,key_hash) values('${ids.venue}','${ids.tenant}','${ids.venue}',repeat('a',64));
    insert into tickit_private.table_links values('${ids.venue}','${ids.venue}',repeat('b',64));
    insert into tickit_private.requests values('${ids.venue}','${ids.venue}',repeat('c',64),'[]','{}');`)
  // Install the real append-only fiscal guard, rather than mocking protection.
  const fiscal = read('supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql')
  const start = fiscal.indexOf('create function public.fiscal_local_record_immutable()')
  const end = fiscal.indexOf('alter table public.fiscal_subjects', start)
  await db.exec(fiscal.slice(start, end))
  await db.exec(read('supabase/migrations/20261101190202_allow_unused_tenant_billing_cleanup.sql'))
  await db.exec(purgeSql)
  return db
}

describe('complete tenant purge in PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof setup>>
  const prepare = async () => (await db.query('select prepare_platform_tenant_deletion($1,$2) job', [ids.tenant, ids.owner])).rows[0].job
  const purge = () => db.query('select purge_platform_tenant_data($1,$2)', [ids.tenant, ids.owner])
  const finish = () => db.query('select finish_platform_tenant_deletion($1,$2)', [ids.tenant, ids.owner])
  beforeAll(async () => { db = await setup() })
  beforeEach(async () => { await db.exec('begin; set local role service_role') })
  afterEach(async () => { await db.exec('rollback') })

  it('removes billing, fiscal, production, reservations, cyclic sales and exclusive users, preserving another tenant', async () => {
    await db.query("update billing_accounts set stripe_customer_id='cus_fixture',stripe_subscription_id='sub_fixture',source='stripe',status='active',contract='{}' where tenant_id=$1", [ids.tenant])
    await db.query("insert into billing_invoices(stripe_invoice_id,tenant_id,status,currency,amount_due_cents,amount_paid_cents,created_at) values('in_fixture',$1,'paid','eur',100,100,now())", [ids.tenant])
    await db.query("insert into billing_audit(tenant_id,action,reason) values($1,'fixture','History')", [ids.tenant])
    await db.exec("insert into billing_stripe_events(event_id,event_type,stripe_created,stripe_customer_id) values('evt_fixture','invoice.paid',1,'cus_fixture')")
    expect((await prepare()).user_ids).toEqual([member])
    await purge()
    for (const table of ['billing_accounts','billing_invoices','billing_audit','fiscal_local_records','fiscal_sif_installations','fiscal_subjects','production_items','production_batches','tickets','sales','reservations']) {
      expect((await db.query(`select * from ${table} where tenant_id=$1`, [ids.tenant])).rows, table).toHaveLength(0)
    }
    expect((await db.query('select * from fiscal_bridge_requests')).rows).toHaveLength(0)
    expect((await db.query('select * from billing_stripe_events')).rows).toHaveLength(0)
    await db.exec('reset role')
    for (const table of ['integrations','table_links','sessions','requests']) expect((await db.query(`select * from tickit_private.${table}`)).rows).toHaveLength(0)
    await db.exec('set local role service_role')
    // Finalization cannot succeed while an exclusive Auth user still exists.
    await db.exec('savepoint finish')
    await expect(finish()).rejects.toThrow('TENANT_DELETION_INCOMPLETE')
    await db.exec('rollback to savepoint finish')
    await db.query('delete from auth.users where id=$1', [member])
    await db.query('select ack_platform_tenant_deleted_user($1,$2)', [ids.tenant,member])
    await finish()
    expect((await db.query('select id from tenants')).rows).toEqual([{ id: ids.other }])
    expect((await db.query('select tenant_id from billing_accounts')).rows).toEqual([{ tenant_id: ids.other }])
    expect((await db.query('select * from platform_tenant_deletion_jobs')).rows).toHaveLength(0)
    expect((await db.query('select id from auth.users order by id')).rows).toEqual([{ id: ids.owner }, { id: ids.stranger }])
    expect((await db.query("select current_setting('tickit.purge_tenant',true) marker")).rows[0].marker).toBe('')
  })

  it('blocks ordinary fiscal deletes and cannot forge a purge from an authenticated session', async () => {
    await db.exec('savepoint guarded')
    await expect(db.query('delete from fiscal_local_records where tenant_id=$1', [ids.tenant])).rejects.toThrow('append-only')
    await db.exec('rollback to savepoint guarded')
    await db.exec(`reset role; grant select,delete on fiscal_local_records to authenticated; set local role authenticated; select set_config('tickit.purge_tenant','${ids.tenant}',true)`)
    await expect(db.query('delete from fiscal_local_records where tenant_id=$1', [ids.tenant])).rejects.toThrow('append-only')
  })

  it('preserves the old direct DELETE API and its ordinary cascades for unused tenants', async () => {
    await db.query('delete from tenants where id=$1', [ids.other])
    expect((await db.query('select * from legacy_children')).rows).toHaveLength(0)
  })

  it('preserves deferred catalog constraint behavior outside a purge after adapting its unterminated block', async () => {
    await db.query('insert into product_modifier_group_assignments values($1,$2,$1,true,1)', [ids.venue,ids.tenant])
    await db.exec('set constraints all immediate')
    await expect(db.query('delete from modifiers where tenant_id=$1', [ids.tenant])).rejects.toThrow('INSUFFICIENT_ACTIVE_MODIFIER_CAPACITY')
  })

  it('exposes purge RPCs only to service_role, additionally requiring a superadmin actor', async () => {
    await db.exec('savepoint forbidden')
    await expect(db.query('select prepare_platform_tenant_deletion($1,$2)', [ids.tenant, ids.stranger])).rejects.toThrow('TENANT_DELETION_FORBIDDEN')
    await db.exec('rollback to savepoint forbidden; set local role authenticated')
    await expect(prepare()).rejects.toThrow('permission denied')
  })

  it('reserves exclusive users and rejects uploads and writes while deletion is pending', async () => {
    const first = await prepare()
    expect((await prepare()).request_id).toBe(first.request_id)
    for (const statement of [
      `insert into reservations values(gen_random_uuid(),'${ids.tenant}')`,
      `insert into tenant_memberships values('${ids.other}','${member}','cashier',true)`,
      `insert into storage.objects(bucket_id,name) values('product-images','${ids.tenant}/image.webp')`,
      `update tenants set is_active=true where id='${ids.tenant}'`,
    ]) {
      await db.exec('savepoint blocked')
      await expect(db.exec(statement)).rejects.toThrow('TENANT_DELETION_IN_PROGRESS')
      await db.exec('rollback to savepoint blocked')
    }
    await db.query('insert into reservations values(gen_random_uuid(),$1)', [ids.other])
  })

  it('does not purge before physical storage cleanup and returns bounded, correctly scoped pages', async () => {
    await db.query("insert into storage.objects(bucket_id,name) select 'supplier-documents',$1 || '/' || n from generate_series(1,205) n", [ids.tenant])
    await db.query("insert into storage.objects(bucket_id,name) values('supplier-documents',$1 || '/keep')", [ids.other])
    await prepare()
    expect((await db.query('select * from list_platform_tenant_deletion_objects($1)', [ids.tenant])).rows).toHaveLength(200)
    await expect(purge()).rejects.toThrow('TENANT_DELETION_STORAGE_PENDING')
  })

  it('preserves shared users', async () => {
    await db.query('insert into tenant_memberships values($1,$2,$3,true)', [ids.other, member, 'cashier'])
    expect((await prepare()).user_ids).toEqual([])
  })

  it('preserves identities referenced by another tenant history even without another membership', async () => {
    await db.query("insert into billing_audit(tenant_id,actor_id,action,reason) values($1,$2,'fixture','Other tenant history')", [ids.other,member])
    expect((await prepare()).user_ids).toEqual([])
  })

  it('rolls back the entire data phase when a cross-tenant FK would cascade into another tenant', async () => {
    await db.exec('reset role; create table cross_tenant_link(tenant_id uuid,record_id uuid references fiscal_local_records(id) on delete cascade);')
    // Install the same generic fence used on tenant tables at migration time.
    await db.exec('create trigger guard_platform_tenant_deletion_write before insert or update or delete on cross_tenant_link for each row execute function guard_platform_tenant_deletion_write(); grant all on cross_tenant_link to service_role; set local role service_role')
    await db.query('insert into cross_tenant_link values($1,$2)', [ids.other, ids.venue])
    await prepare()
    await db.exec('savepoint cross_tenant')
    await expect(purge()).rejects.toThrow('TENANT_DELETION_CROSS_TENANT_REFERENCE')
    await db.exec('rollback to savepoint cross_tenant')
    expect((await db.query('select * from fiscal_local_records')).rows).toHaveLength(1)
    expect((await db.query('select * from billing_accounts where tenant_id=$1', [ids.tenant])).rows).toHaveLength(1)
  })

  it('does not persist delayed Stripe events for deleting or deleted customers', async () => {
    await db.query("update billing_accounts set stripe_customer_id='cus_fixture' where tenant_id=$1", [ids.tenant])
    await prepare()
    await db.exec("insert into billing_stripe_events(event_id,event_type,stripe_created,stripe_customer_id) values('evt_late','invoice.paid',1,'cus_fixture')")
    expect((await db.query('select * from billing_stripe_events')).rows).toHaveLength(0)
    await purge()
    await db.exec("insert into billing_stripe_events(event_id,event_type,stripe_created,stripe_customer_id) values('evt_after','invoice.paid',1,'cus_fixture')")
    expect((await db.query('select * from billing_stripe_events')).rows).toHaveLength(0)
  })

  it('runs the real orchestrator and SQL phases through storage and Auth boundaries', async () => {
    await db.query("update billing_accounts set stripe_customer_id='cst_fixture',stripe_subscription_id='sub_fixture',status='active' where tenant_id=$1", [ids.tenant])
    await db.query("insert into storage.objects(bucket_id,name) values('product-images',$1 || '/image'),('supplier-documents',$2 || '/keep')", [ids.tenant,ids.other])
    const client = {
      rpc: async (name: string, params: Record<string, string>) => {
        const keys = Object.keys(params)
        const result = await db.query(`select to_jsonb(public.${name}(${keys.map((key,index) => `${key}=>$${index+1}`).join(',')})) result`, Object.values(params))
        return { data: name === 'list_platform_tenant_deletion_objects' ? result.rows.map((row: { result: object }) => row.result) : result.rows[0].result, error: null }
      },
      from(table: string) {
        let column = ''; let value = ''
        return { select() { return this }, limit() { return this },
          eq(key: string, input: string) { column = key; value = input; return this },
          maybeSingle: async () => ({ data: (await db.query(`select * from ${table} where ${column}=$1 limit 1`, [value])).rows[0] ?? null, error: null }) }
      },
      storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => {
        await db.query('delete from storage.objects where bucket_id=$1 and name=any($2)', [bucket,paths]); return { error: null }
      } }) },
      auth: { admin: { deleteUser: async (id: string) => { await db.query('delete from auth.users where id=$1', [id]); return { error: null } } } },
    }
    const mollie = () => ({ list: async () => [], request: async (method: string) => method === 'GET'
      ? { id: 'cst_fixture', metadata: { tickit_tenant_id: ids.tenant } } : null })
    await deletion.deletePlatformTenantData(client, ids.tenant, ids.owner, mollie)
    expect((await db.query('select id from tenants')).rows).toEqual([{ id: ids.other }])
    expect((await db.query('select name from storage.objects')).rows).toEqual([{ name: `${ids.other}/keep` }])
    expect((await db.query('select * from platform_tenant_deletion_jobs')).rows).toEqual([])
  })
})

function serviceFixture(options: { stripe?: boolean; shared?: boolean; stripeFailure?: boolean; stripeLostReply?: boolean; stripeTenant?: string; storageFailure?: boolean; authFailure?: boolean; lookupFailure?: boolean; foreignObject?: boolean; databaseFailure?: boolean; databaseLostReply?: boolean; finishFailure?: boolean } = {}) {
  let job: Record<string, unknown> | null = {
    tenant_id: ids.tenant, request_id: ids.venue, stripe_customer_id: options.stripe ? 'cst_fixture' : null,
    stripe_subscription_id: null, user_ids: [member], database_purged: false,
  }
  let customerDeleted = false
  let files = [`${ids.tenant}/1`, `${ids.tenant}/2`, `${ids.tenant}/3`]
  const calls: string[] = []
  const db = {
    rpc: async (name: string, params: Record<string, string>) => {
      calls.push(name)
      if (name === 'prepare_platform_tenant_deletion') return { data: job, error: null }
      if (name === 'list_platform_tenant_deletion_objects') return { data: options.foreignObject ? [{ bucket_id: 'product-images', name: `${ids.other}/file` }] : files.slice(0, 2).map(name => ({ bucket_id: 'product-images', name })), error: null }
      if (name === 'purge_platform_tenant_data') {
        if (options.databaseFailure) return { data: null, error: new Error('fixture') }
        if (job) job.database_purged = true
        if (options.databaseLostReply) return { data: null, error: new Error('fixture') }
      }
      if (name === 'ack_platform_tenant_deleted_user' && job) job.user_ids = (job.user_ids as string[]).filter(id => id !== params.p_user_id)
      if (name === 'finish_platform_tenant_deletion') {
        if (options.finishFailure) return { data: null, error: new Error('fixture') }
        job = null
      }
      return { data: null, error: null }
    },
    storage: { from: () => ({ remove: async (paths: string[]) => {
      calls.push('storage.remove')
      if (options.storageFailure) return { error: new Error('fixture') }
      files = files.filter(path => !paths.includes(path))
      return { error: null }
    } }) },
    from(table: string) {
      return { select() { return this }, eq() { return this }, limit() { return this },
        maybeSingle: async () => ({ data: table === 'profiles' ? { is_superadmin: false } : options.shared ? { id: 'shared' } : null, error: options.lookupFailure ? new Error('fixture') : null }) }
    },
    auth: { admin: { deleteUser: async (_id: string, soft?: boolean) => {
      expect(soft).toBeUndefined()
      calls.push('auth.delete')
      return { error: options.authFailure ? new Error('fixture') : null }
    } } },
  }
  const subscriptions = [{ id: 'sub_live', status: 'active' }, { id: 'sub_old', status: 'canceled' }]
  const mollie = () => ({
    list: async () => { calls.push('stripe.LIST'); return structuredClone(subscriptions) },
    request: async (method: string, path: string) => {
      calls.push(`stripe.${method}`)
      if (options.stripeFailure) throw new Error('fixture')
      if (customerDeleted) throw new MollieRequestError(404, null)
      if (method === 'GET') return { id: 'cst_fixture', metadata: { tickit_tenant_id: options.stripeTenant ?? ids.tenant } }
      if (path.includes('/subscriptions/')) { subscriptions[0].status = 'canceled'; calls.push('subscription.canceled'); return null }
      customerDeleted = true
      if (options.stripeLostReply) throw new Error('fixture lost reply')
      return null
    },
  })
  return { run: () => deletion.deletePlatformTenantData(db, ids.tenant, ids.owner, mollie), calls, options,
    job: () => job, files: () => files }
}

it('orders external cleanup before the atomic purge, hard-deletes exclusive users and finishes idempotently', async () => {
  const fixture = serviceFixture({ stripe: true })
  await fixture.run()
  expect(fixture.files()).toEqual([])
  expect(fixture.job()).toBeNull()
  // Future Mollie charges stop before the customer and the tenant data are removed.
  expect(fixture.calls.indexOf('subscription.canceled')).toBeLessThan(fixture.calls.lastIndexOf('stripe.DELETE'))
  expect(fixture.calls.filter(call => call === 'stripe.DELETE')).toHaveLength(2)
  expect(fixture.calls.lastIndexOf('stripe.DELETE')).toBeLessThan(fixture.calls.indexOf('purge_platform_tenant_data'))
  expect(fixture.calls.indexOf('storage.remove')).toBeLessThan(fixture.calls.indexOf('purge_platform_tenant_data'))
  expect(fixture.calls.indexOf('purge_platform_tenant_data')).toBeLessThan(fixture.calls.indexOf('auth.delete'))
  await fixture.run()
})

it.each(['stripeFailure', 'stripeLostReply', 'storageFailure', 'authFailure', 'lookupFailure', 'databaseFailure', 'databaseLostReply', 'finishFailure'] as const)('keeps a resumable job after %s and finishes on retry', async (key) => {
  const fixture = serviceFixture({ stripe: true, [key]: true })
  await expect(fixture.run()).rejects.toThrow()
  expect(fixture.job()).not.toBeNull()
  if (key !== 'finishFailure') expect(fixture.calls).not.toContain('finish_platform_tenant_deletion')
  fixture.options[key] = false
  await fixture.run()
  expect(fixture.job()).toBeNull()
  expect(fixture.calls.filter(call => call === 'subscription.canceled')).toHaveLength(1)
  expect(fixture.job()).toBeNull()
})

it('never deletes a shared user or a storage path from another tenant', async () => {
  const shared = serviceFixture({ shared: true })
  await expect(shared.run()).rejects.toThrow()
  expect(shared.calls).not.toContain('auth.delete')
  const foreign = serviceFixture({ foreignObject: true })
  await expect(foreign.run()).rejects.toThrow()
  expect(foreign.calls).not.toContain('storage.remove')
  const foreignStripe = serviceFixture({ stripe: true, stripeTenant: ids.other })
  await expect(foreignStripe.run()).rejects.toThrow()
  expect(foreignStripe.calls).not.toContain('stripe.DELETE')
})

it('checks Superadmin permission before dispatch and returns actionable deletion failures', async () => {
  const source = read('supabase/functions/manage-pos-users/index.ts')
  async function request(superadmin: boolean, fail = false) {
    let calls = 0
    let handler = async (_request: Request): Promise<Response> => new Response(null, { status: 500 })
    const client = { auth: { getUser: async () => ({ data: { user: { id: ids.owner } }, error: null }) },
      from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: { is_superadmin: superadmin }, error: null }) }) }
    compileComponent(source, {
      'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
      '../_shared/billing/service.ts': {}, '../_shared/billing/mollie.ts': {}, '../_shared/billing/schemas.ts': {},
      '../_shared/billing/env.ts': { billingEnv: () => ({ mollieKey: '' }), loadBillingSecrets: async () => ({}) },
      '../_shared/billing/onboarding.ts': {}, '../_shared/welcome-email.ts': {},
      '../_shared/platform-tenant-deletion.ts': { TenantDeletionError: deletion.TenantDeletionError, deletePlatformTenantData: async () => {
        calls++; if (fail) throw new deletion.TenantDeletionError('Vuelve a eliminar el negocio para continuar.')
      } },
    }, { Deno: { serve: (callback: typeof handler) => { handler = callback }, env: { get: () => 'fixture' } }, Response, console })
    const reply = await handler(new Request('http://localhost', { method: 'POST', headers: { Authorization: 'Bearer fixture' },
      body: JSON.stringify({ action: 'platform-delete-tenant', tenantId: ids.tenant }) }))
    return { reply, calls }
  }
  const forbidden = await request(false)
  expect(forbidden.reply.status).toBe(403)
  expect(forbidden.calls).toBe(0)
  expect((await request(true)).reply.status).toBe(200)
  const failed = await request(true, true)
  expect(failed.reply.status).toBe(503)
  expect((await failed.reply.json()).error).toContain('Vuelve a eliminar')
})
