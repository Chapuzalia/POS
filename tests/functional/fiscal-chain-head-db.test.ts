import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const migration = read('20261114013511_read_fiscal_chain_head_with_ordered_index.sql')
const originalPolicy = read('20260928120000_prepare_local_verifactu_scope.sql')
  .match(/create policy fiscal_local_records_read[\s\S]*?;/)?.[0]
const gestorPolicy = read('20261111120100_gestor_sales_report_access.sql')
  .match(/create policy fiscal_local_records_gestor_read[\s\S]*?;/)?.[0]
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), subject = id(2), installation = id(3), venue = id(4), user = id(5)
const otherInstallation = id(6), otherVenue = id(7), foreignTenant = id(8), foreignSubject = id(9), foreignInstallation = id(10)
let db: PGlite
const call = async (tenantId = tenant, subjectId = subject, installationId = installation) =>
  (await db.query('select * from public.pos_fiscal_chain_head($1,$2,$3)', [tenantId, subjectId, installationId])).rows

beforeAll(async () => {
  db = new PGlite()
  if (!originalPolicy || !gestorPolicy) throw new Error('Missing deployed fiscal read policy')
  await db.exec(`
    create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    create table public.fiscal_local_records (
      id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
      fiscal_subject_id uuid not null, installation_id uuid not null, venue_id uuid not null,
      ticket_id uuid, sale_id uuid, refund_request_id uuid, record_kind text not null,
      chain_position bigint not null, hash text not null, record_envelope jsonb not null,
      invoice_snapshot jsonb not null, economic_snapshot jsonb, rpc_result jsonb,
      unique(tenant_id,fiscal_subject_id,installation_id,chain_position)
    );
    -- Auth-helper stand-ins keep the deployed policies while varying the caller's grants.
    create function public.user_is_tenant_admin(t uuid) returns boolean language sql stable as
      $$ select t=nullif(current_setting('test.tenant',true),'')::uuid
        and current_setting('test.role',true) in ('owner','manager') $$;
    create function public.user_has_tenant_role(t uuid,roles text[]) returns boolean language sql stable as
      $$ select t=nullif(current_setting('test.tenant',true),'')::uuid
        and current_setting('test.role',true)=any(roles) $$;
    create function public.user_has_venue_access(t uuid,v uuid) returns boolean language sql stable as
      $$ select t=nullif(current_setting('test.tenant',true),'')::uuid
        and v=nullif(current_setting('test.venue',true),'')::uuid
        and current_setting('test.role',true)='cashier' $$;
    alter table public.fiscal_local_records enable row level security;
    ${originalPolicy}
    ${gestorPolicy}
    create policy billing_activation_access on public.fiscal_local_records as restrictive
      for select to authenticated using (current_setting('test.billing_blocked',true)<>'yes');
    create policy platform_tenant_deletion_access on public.fiscal_local_records as restrictive
      for select to authenticated using (current_setting('test.deleting',true)<>'yes');
    grant select on public.fiscal_local_records to authenticated;
    insert into public.fiscal_local_records(tenant_id,fiscal_subject_id,installation_id,venue_id,record_kind,
      chain_position,hash,record_envelope,invoice_snapshot,economic_snapshot,rpc_result)
    select '${tenant}','${subject}','${installation}','${venue}',
      case when n=2741 then 'anulacion' else 'alta' end,n,repeat('A',64),
      jsonb_build_object('chainPosition',n),jsonb_build_object('totalCents',1210,'number',n),
      '{"totalCents":1210}',jsonb_build_object('saleId','original-sale')
    from generate_series(1,2741) n;
    insert into public.fiscal_local_records(tenant_id,fiscal_subject_id,installation_id,venue_id,record_kind,
      chain_position,hash,record_envelope,invoice_snapshot)
    values ('${tenant}','${subject}','${otherInstallation}','${otherVenue}','alta',9000,repeat('B',64),'{}','{}'),
      ('${foreignTenant}','${foreignSubject}','${foreignInstallation}','${otherVenue}','alta',10000,repeat('C',64),'{}','{}');
    analyze public.fiscal_local_records;
    ${migration}
  `)
})

beforeEach(async () => {
  await db.exec('reset role; set enable_bitmapscan=on;')
  for (const [key, value] of Object.entries({ uid: user, tenant, venue, role: 'cashier', billing_blocked: 'no', deleting: 'no' })) {
    await db.query('select set_config($1,$2,false)', [`test.${key}`, value])
  }
  await db.exec('set role authenticated')
})
afterAll(async () => { await db?.close() })

it('returns the original latest fiscal snapshot, including an annulment, without scanning history', async () => {
  const rowsRead = async () => {
    await db.exec('select pg_stat_force_next_flush(); select pg_stat_clear_snapshot();')
    const [stats] = (await db.query(`select seq_tup_read+idx_tup_fetch as n
      from pg_stat_user_tables where relid='public.fiscal_local_records'::regclass`)).rows
    return Number(stats.n)
  }
  const before = await rowsRead()
  const result = await call()
  expect(await rowsRead() - before).toBeLessThan(10)
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ tenant_id: tenant, fiscal_subject_id: subject, installation_id: installation,
    chain_position: 2741, record_kind: 'anulacion', hash: 'A'.repeat(64), record_envelope: { chainPosition: 2741 },
    invoice_snapshot: { totalCents: 1210, number: 2741 }, economic_snapshot: { totalCents: 1210 }, rpc_result: { saleId: 'original-sale' } })
  expect(Object.keys(result[0]).sort()).toEqual(['id','tenant_id','fiscal_subject_id','installation_id','ticket_id','sale_id',
    'refund_request_id','record_kind','chain_position','hash','record_envelope','invoice_snapshot','economic_snapshot','rpc_result'].sort())
  expect((await db.query("select current_setting('enable_bitmapscan') value")).rows[0].value).toBe('on')
})

it('keeps tenant, subject, installation and venue boundaries for assigned cashiers', async () => {
  expect(await call(tenant, subject, otherInstallation)).toEqual([])
  expect(await call(foreignTenant, foreignSubject, foreignInstallation)).toEqual([])
  expect(await call(tenant, foreignSubject, installation)).toEqual([])
  expect(await call(tenant, subject, id(99))).toEqual([])
  await db.query("select set_config('test.uid','',false)")
  expect(await call()).toEqual([])
})

it.each(['owner','manager','gestor'])('preserves existing tenant-wide read access for %s', async role => {
  await db.query("select set_config('test.role',$1,false)", [role])
  expect(await call()).toHaveLength(1)
  expect(await call(tenant, subject, otherInstallation)).toHaveLength(1)
  expect(await call(foreignTenant, foreignSubject, foreignInstallation)).toEqual([])
})

it.each(['billing_blocked','deleting'])('preserves the restrictive %s RLS policy', async key => {
  await db.query('select set_config($1,$2,false)', [`test.${key}`, 'yes'])
  expect(await call()).toEqual([])
})

it('retains invoker security, authenticated-only execution and a function-local planner setting', async () => {
  const [rpc] = (await db.query(`select prosecdef,provolatile,prorows,proconfig,
    has_function_privilege('authenticated',oid,'execute') as authenticated,
    has_function_privilege('anon',oid,'execute') as anon
    from pg_proc where oid='public.pos_fiscal_chain_head(uuid,uuid,uuid)'::regprocedure`)).rows
  expect(rpc).toMatchObject({ prosecdef: false, provolatile: 's', prorows: 1, authenticated: true, anon: false })
  expect(rpc.proconfig).toContain('enable_bitmapscan=off')
  await db.exec('set role anon')
  await expect(call()).rejects.toThrow(/permission denied/)
})
