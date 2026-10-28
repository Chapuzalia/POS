import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = source('../supabase/migrations/20261011183718_verifactu_activation_requests.sql')
const tenant = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const owner = '33333333-3333-4333-8333-333333333333'
const manager = '44444444-4444-4444-8444-444444444444'
const admin = '55555555-5555-4555-8555-555555555555'

test('owner requests once, superadmin configures and activates atomically, tenant permissions protect configuration', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table tenants(id uuid primary key);
    create table tenant_memberships(tenant_id uuid, user_id uuid, role text, is_active boolean);
    create function user_is_superadmin() returns boolean language sql stable as $$ select auth.uid()='${admin}'::uuid $$;
    create function user_is_tenant_admin(uuid) returns boolean language sql stable as $$ select exists(select 1 from tenant_memberships where tenant_id=$1 and user_id=auth.uid() and is_active and role in ('owner','manager')) $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select exists(select 1 from tenant_memberships where tenant_id=$1 and user_id=auth.uid() and is_active) $$;
    create table fiscal_sif_installations(tenant_id uuid, venue_id uuid, retired_at timestamptz);
    create table sales(id uuid primary key,tenant_id uuid,local_created_at timestamptz not null);
    create function fiscal_local_require_sale_record() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger fiscal_local_sale_required before insert on sales for each row execute function fiscal_local_require_sale_record();
    grant usage on schema public,auth to authenticated;
    grant select on tenant_memberships,fiscal_sif_installations to authenticated;
    insert into tenants values('${tenant}'),('${other}');
    insert into auth.users values('${owner}'),('${manager}'),('${admin}');
    insert into tenant_memberships values('${tenant}','${owner}','owner',true),('${tenant}','${manager}','manager',true);
  `)
  for (const file of ['20260928160000_fiscal_pos_bridge_settings.sql','20260929150000_allow_local_fiscal_without_bridge.sql','20260929180000_add_aeat_environment_setting.sql','20261003140000_add_ticket_qr_print_setting.sql']) {
    await db.exec(source(`../supabase/migrations/${file}`))
  }
  await db.exec(migration)
  const login = async user => {
    await db.exec('reset role')
    await db.query("select set_config('test.uid',$1,false)",[user])
    await db.exec('set role authenticated')
  }
  const request = () => db.query('select request_verifactu_activation($1) as value',[tenant])
  const configure = (activate, url = 'https://bridge.example/') => db.query(
    'select configure_verifactu_integration($1,$2,$3,$4,$5,$6,$7) as value',
    [tenant,url,'Productor SL','B12345678','TK','1.0',activate])
  await login(owner)
  await db.query('select save_verifactu_preferences($1,$2,$3)',[tenant,'test',false])
  assert.equal((await db.query('select requested_at from tenant_verifactu_integrations')).rows[0].requested_at,null)
  const first = (await request()).rows[0].value
  assert.equal(first.enabled_at,null)
  assert.equal(first.aeat_environment,'test')
  assert.equal(first.print_ticket_qr,false)
  assert.equal((await request()).rows[0].value.requested_at,first.requested_at)
  await assert.rejects(db.query('select request_verifactu_activation($1)',[other]), /propietario/)
  await assert.rejects(configure(true), /superadmin/)
  await assert.rejects(db.query('update tenant_verifactu_integrations set enabled_at=now()'), /permission denied/)
  await assert.rejects(db.query(`insert into fiscal_pos_bridge_settings(tenant_id,bridge_url,producer_name,producer_nif,system_id,system_version)
    values($1,'https://b.example/','SL','B12345678','TK','1')`,[tenant]), /row-level security/)
  await login(manager)
  assert.equal((await db.query('select * from tenant_verifactu_integrations')).rows.length,1)
  await assert.rejects(request(),/propietario/)
  await assert.rejects(db.query('select save_verifactu_preferences($1,$2,$3)',[tenant,'test',true]),/propietario/)
  await login(admin)
  await assert.rejects(db.query('select configure_verifactu_integration($1,$2,$3,$4,$5,$6,true)',[other,'https://bridge.example/','SL','B12345678','TK','1']),/no ha solicitado/)
  await assert.rejects(configure(true,''),/URL/)
  assert.equal((await db.query('select * from fiscal_pos_bridge_settings')).rows.length,0,'failed activation must not save partial configuration')
  assert.equal((await configure(false)).rows[0].value.enabled_at,null)
  assert.deepEqual((await db.query('select aeat_environment,print_ticket_qr from fiscal_pos_bridge_settings')).rows,[{aeat_environment:'test',print_ticket_qr:false}])
  await assert.rejects(configure(true,'http://remote.example/'),/check constraint/)
  const enabled = (await configure(true)).rows[0].value
  assert.ok(enabled.enabled_at)
  assert.equal(enabled.enabled_by,admin)
  assert.equal((await configure(true)).rows[0].value.enabled_at,enabled.enabled_at)
  await assert.rejects(configure(false,''),/URL/,'active integrations must retain their bridge')
  await login(owner)
  assert.equal((await db.query("select * from tenant_verifactu_integrations where tenant_id=$1",[other])).rows.length,0)
  assert.equal((await db.query('update fiscal_pos_bridge_settings set bridge_url=$1 returning *',['https://evil.example/'])).rows.length,0)
  await db.query('select save_verifactu_preferences($1,$2,$3)',[tenant,'production',true])
  assert.deepEqual((await db.query('select aeat_environment,print_ticket_qr,bridge_url from fiscal_pos_bridge_settings')).rows,[{aeat_environment:'production',print_ticket_qr:true,bridge_url:'https://bridge.example/'}])
  await db.exec('reset role')
  await db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2020-01-01T00:00:00Z'])
  await assert.rejects(db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2100-01-01T00:00:00Z']),/LOCAL_FISCAL_RECORD_REQUIRED/)
  await db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),other,'2100-01-01T00:00:00Z'])
  await db.exec("begin; select set_config('app.local_fiscal_sale','yes',true);")
  await db.query('insert into sales values($1,$2,$3)',[crypto.randomUUID(),tenant,'2100-01-01T00:00:00Z'])
  await db.exec('commit')
  await db.exec(`update tenant_memberships set is_active=false where user_id='${owner}'`)
  await login(owner)
  await assert.rejects(request(),/propietario/)
  assert.equal((await db.query('select * from tenant_verifactu_integrations')).rows.length,0)
  await db.exec('reset role; set role anon')
  await assert.rejects(request(),/permission denied/)
})
