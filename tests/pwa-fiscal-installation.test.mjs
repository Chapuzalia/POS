import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { fiscalSeries } from '../src/features/fiscal/local/fiscalPolicy.ts'
import { compileComponent } from './helpers/component-harness.mjs'
import { canonicalRecordSchema, createAltaRecord } from '../src/features/fiscal/local/canonical.ts'
import { aeatHash } from '../src/features/fiscal/local/verifactu.ts'
import { UserFacingError } from '../src/utils/UserFacingError.ts'

const migration = readFileSync(new URL('../supabase/migrations/20261002191101_pwa_fiscal_installation_identity.sql', import.meta.url), 'utf8')
const schema = readFileSync(new URL('../supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql', import.meta.url), 'utf8')
const simplify = readFileSync(new URL('../supabase/migrations/20260929190000_simplify_sif_series_identity.sql', import.meta.url), 'utf8')
const sale = readFileSync(new URL('../supabase/migrations/20260928130000_sync_local_verifactu_sale.sql', import.meta.url), 'utf8')
const restaurant = readFileSync(new URL('../supabase/migrations/20260928140000_restaurant_local_verifactu_sale.sql', import.meta.url), 'utf8')
const tenant = '11111111-1111-4111-8111-111111111111'
const venue = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'
const register = '44444444-4444-4444-8444-444444444444'
const subject = '55555555-5555-4555-8555-555555555555'
const legacy = '66666666-6666-4666-8666-666666666666'
const requestId = '77777777-7777-4777-8777-777777777777'

async function database(t, withLegacy = false) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${device}'::uuid $$;
    create table tenants(id uuid primary key);
    create table venues(id uuid primary key,tenant_id uuid,timezone text);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean default true,can_take_payments boolean default true);
    create table cash_registers(id uuid primary key,tenant_id uuid,venue_id uuid);
    create table tickets(id uuid primary key);
    create table sales(id uuid primary key);
    create function user_is_tenant_admin(uuid) returns boolean language sql as $$ select true $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql as $$ select true $$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql as $$ select $1='${tenant}'::uuid and $2='${venue}'::uuid and $3='${device}'::uuid $$;
    create table fiscal_pos_bridge_settings(tenant_id uuid,aeat_environment text);
    insert into tenants values('${tenant}');
    insert into venues values('${venue}','${tenant}','Europe/Madrid');
    insert into devices values('${device}','${tenant}','${venue}');
    insert into cash_registers values('${register}','${tenant}','${venue}');
    insert into fiscal_pos_bridge_settings values('${tenant}','test');
  `)
  await db.exec(schema)
  // Install real sale/restaurant definitions to check the upgrade against the actual routines.
  await db.exec(sale)
  await db.exec(restaurant)
  await db.exec(simplify)
  await db.exec('alter table cash_registers add column is_active boolean default true')
  await db.exec(`update venues set fiscal_code='BCN'; insert into fiscal_subjects(id,tenant_id,legal_name,nif) values('${subject}','${tenant}','Bar SL','B12345678');`)
  if (withLegacy) await db.exec(`insert into fiscal_sif_installations(id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode)
    values('${legacy}','${tenant}','${subject}','${venue}','${register}','${device}','OLD-NUMBER','BCN','C1','OLD1','production')`)
  // PostgreSQL concurrent indexes must be executed as standalone statements.
  for (const statement of migration.split(/(create (?:unique )?index concurrently[^;]+;)/i)) {
    if (statement.trim()) await db.exec(statement)
  }
  return db
}

async function activate(db, { expected = null, request = requestId, recover = false, registerId = register, tenantId = tenant } = {}) {
  const result = await db.query('select activate_pwa_fiscal_installation($1,$2,$3,$4,$5,$6,$7) as id', [tenantId,venue,registerId,device,request,expected,recover])
  return result.rows[0].id
}

test('new PWA installations allocate per-register identity and retries return the committed result', async t => {
  const db = await database(t)
  const first = await activate(db)
  assert.equal(await activate(db), first)
  const row = (await db.query('select * from fiscal_sif_installations where id=$1',[first])).rows[0]
  assert.equal(row.installation_sequence, 1)
  assert.equal(row.installation_number, 'BCN-C1-1')
  assert.equal(row.series_version, 2)
  const second = await activate(db,{ expected:first, request:crypto.randomUUID() })
  const replacement = (await db.query('select * from fiscal_sif_installations where id=$1',[second])).rows[0]
  assert.equal(replacement.installation_number, 'BCN-C1-2')
  assert.ok((await db.query('select retired_at from fiscal_sif_installations where id=$1',[first])).rows[0].retired_at)
  await assert.rejects(activate(db), /ALREADY_RETIRED/)
  await assert.rejects(activate(db,{request:crypto.randomUUID(),expected:first}), /CONFIRMATION_STALE/)
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations')).rows[0].n,2)
  await assert.rejects(db.exec(`update fiscal_sif_installations set installation_sequence=99 where id='${second}'`), /cannot be reused/)
})

test('legacy adaptation preserves identity and reserves its sequence even after retirement', async t => {
  const db = await database(t,true)
  const old = (await db.query('select * from fiscal_sif_installations where id=$1',[legacy])).rows[0]
  assert.equal(old.installation_number,'OLD-NUMBER')
  assert.equal(old.installation_sequence,1)
  assert.equal(old.series_version,1)
  const next = await activate(db,{expected:legacy})
  assert.equal((await db.query('select installation_number from fiscal_sif_installations where id=$1',[next])).rows[0].installation_number,'BCN-C1-2')
  assert.equal((await db.query('select fiscal_installation_series_prefix(i) as prefix from fiscal_sif_installations i where id=$1',[legacy])).rows[0].prefix,'BCN-C1')
})

test('devices without payment permission cannot activate or recover a fiscal installation', async t => {
  const db = await database(t, true)
  await db.query('update devices set can_take_payments=false where id=$1', [device])
  await assert.rejects(activate(db, { expected: legacy }), /FISCAL_ACTIVATION_FORBIDDEN/)
  await assert.rejects(activate(db, { expected: legacy, recover: true }), /FISCAL_ACTIVATION_FORBIDDEN/)
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations')).rows[0].n, 1)
  assert.equal((await db.query('select retired_at from fiscal_sif_installations where id=$1', [legacy])).rows[0].retired_at, null)
})

test('test recovery never retires or creates an installation and is rejected for production or other tenants', async t => {
  const db = await database(t,true)
  assert.equal(await activate(db,{expected:legacy,recover:true}),legacy)
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations')).rows[0].n,1)
  assert.equal((await db.query('select retired_at from fiscal_sif_installations')).rows[0].retired_at,null)
  await db.exec(`update fiscal_pos_bridge_settings set aeat_environment='production'`)
  await assert.rejects(activate(db,{expected:legacy,recover:true}), /TEST_RECOVERY_FORBIDDEN/)
  await assert.rejects(activate(db,{tenantId:crypto.randomUUID()}), /ACTIVATION_FORBIDDEN/)
})

test('server parsing supports both series layouts and upgraded validators use installation prefix', async t => {
  const db = await database(t,true)
  for (const name of ['sync_local_fiscal_sale_created','pay_restaurant_local_fiscal']) {
    const text = (await db.query('select pg_get_functiondef(oid) as d from pg_proc where proname=$1',[name])).rows[0].d
    assert.match(text,/fiscal_installation_series_prefix\(v_installation\)/)
    assert.match(text,/fiscal_series_exercise\(v_series_name\)/)
    assert.match(text,/generatedAt.*>= v_installation.retired_at/)
  }
  for (const series of ['BCN-C1-2026-S','BCN-C1-1-2026-F','BCN-C1-12-2027-R']) {
    assert.equal((await db.query('select fiscal_series_exercise($1) as y',[series])).rows[0].y,Number(series.split('-').at(-2)))
  }
  await assert.rejects(db.query('select fiscal_series_exercise($1)',['BCN-C1-0-2026-S']), /SERIES_MISMATCH/)
  const base = {venueCode:'BCN',registerCode:'C1',exercise:2026,kind:'simplified'}
  assert.equal(fiscalSeries({...base,installationSequence:1}),'BCN-C1-1-2026-S')
  assert.equal(fiscalSeries({...base,installationSequence:2}),'BCN-C1-2-2026-S')
  assert.equal(fiscalSeries(base),'BCN-C1-2026-S')
  assert.throws(()=>fiscalSeries({...base,installationSequence:0}),/inválida/)
  assert.throws(()=>fiscalSeries({...base,exercise:10000}),/inválida/)
})

function identityHarness({ readError = false } = {}) {
  const data = new Map()
  const store = {
    get: key => { if (readError) throw new Error('read failed'); return data.get(key) },
    add: value => data.set(value.scope,value),
  }
  const service = compileComponent(readFileSync(new URL('../src/features/fiscal/local/localIdentity.ts',import.meta.url),'utf8'), {
    './localLedger.ts': { openLedger: async()=>({transaction:()=>({objectStore:()=>store}),close:()=>{}}), request:async value=>value, transactionDone:async()=>{}, assertInstallationBinding:()=>{} },
    './canonical.ts': {canonicalRecordSchema}, './verifactu.ts': {aeatHash},
    '../../../utils/UserFacingError.ts':{UserFacingError},
  }, {crypto})
  return {service,data}
}

test('IndexedDB read failures never mean missing identity, and pending retries preserve their original confirmation', async()=>{
  const normal = identityHarness()
  assert.equal(await normal.service.readFiscalIdentity('box'),null)
  await assert.rejects(identityHarness({readError:true}).service.readFiscalIdentity('box'),/read failed/)
  const first = await normal.service.fiscalActivationRequest('box','old',false)
  const retry = await normal.service.fiscalActivationRequest('box','other',false)
  assert.equal(first.requestId,retry.requestId)
  assert.equal(retry.expectedInstallationId,'old')
  await assert.rejects(normal.service.fiscalActivationRequest('box','other',true),/misma opción/)
})

test('CRM setup prepares logical codes without consuming the first installation', async t=>{
  const db=await database(t)
  await db.exec(`update venues set fiscal_code=null`)
  await db.query('select save_fiscal_pwa_setup($1,$2,$3,$4)',[tenant,'Bar SL','B12345678',JSON.stringify([{venueId:venue,venueCode:'BCN'}])])
  assert.equal((await db.query('select count(*)::integer as n from fiscal_sif_installations')).rows[0].n,0)
  assert.equal((await db.query('select fiscal_code from cash_registers')).rows[0].fiscal_code,'C1')
  await assert.rejects(db.exec("update cash_registers set fiscal_code='C9'"),/REGISTER_CODE_IMMUTABLE/)
  const first=await activate(db)
  assert.equal((await db.query('select installation_number from fiscal_sif_installations where id=$1',[first])).rows[0].installation_number,'BCN-C1-1')
  await assert.rejects(db.query('select save_fiscal_pwa_setup($1,$2,$3,$4)',[tenant,'Bar SL','B12345678',JSON.stringify([{venueId:venue,venueCode:'MAD'}])]),/VENUE_CODE_IMMUTABLE/)
})

test('different boxes start at 1 with exclusive codes; racing confirmations cannot retire an unconfirmed installation', async t=>{
  const db=await database(t)
  const first=await activate(db)
  const reg2=crypto.randomUUID(), dev2=crypto.randomUUID()
  await db.query('insert into cash_registers(id,tenant_id,venue_id) values($1,$2,$3)',[reg2,tenant,venue])
  await assert.rejects(activate(db,{registerId:reg2,request:crypto.randomUUID()}),/DEVICE_REGISTER_CONFLICT/)
  await db.query('insert into devices values($1,$2,$3)',[dev2,tenant,venue])
  await db.exec(`create or replace function user_has_device_access(uuid,uuid,uuid) returns boolean language sql as $$select $1='${tenant}'::uuid and $2='${venue}'::uuid$$`)
  const second=(await db.query('select activate_pwa_fiscal_installation($1,$2,$3,$4,$5,null,false) as id',[tenant,venue,reg2,dev2,crypto.randomUUID()])).rows[0].id
  assert.equal((await db.query('select installation_number from fiscal_sif_installations where id=$1',[second])).rows[0].installation_number,'BCN-C2-1')
  const results=await Promise.allSettled([activate(db,{expected:first,request:crypto.randomUUID()}),activate(db,{expected:first,request:crypto.randomUUID()})])
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
  assert.equal(results.filter(x=>x.status==='rejected' && /CONFIRMATION_STALE/.test(x.reason.message)).length,1)
})

function ledgerHarness(initial={},failWrites=false){
  const stores=new Map(['bindings','cursors','entries','numbers','delivery'].map(name=>[name,new Map(Object.entries(initial[name]||{}))]))
  const openLedger=async()=>({close(){},transaction(names,mode){
    const copy=new Map([...stores].map(([name,rows])=>[name,new Map(rows)]))
    const tx={aborted:false,mode,copy,abort(){this.aborted=true},objectStore(name){
      const rows=copy.get(name)
      return {get:key=>rows.get(key),getAll:()=>[...rows.values()],put:value=>rows.set(value.scope??value.key??value.id,value),add:value=>rows.set(value.scope??value.key??value.id,value),delete:key=>rows.delete(key),index:()=>({getAll:scope=>[...rows.values()].filter(x=>x.scope===scope),count:scope=>[...rows.values()].filter(x=>x.scope===scope).length})}
    }}
    return tx
  }})
  const transactionDone=tx=>({then(resolve,reject){
    if(tx.aborted || (failWrites&&tx.mode==='readwrite')) reject(new Error('write failed'))
    else {if(tx.mode==='readwrite') for(const [name,rows] of tx.copy) stores.set(name,rows);resolve()}
  }})
  const service=compileComponent(readFileSync(new URL('../src/features/fiscal/local/localIdentity.ts',import.meta.url),'utf8'),{
    './localLedger.ts':{openLedger,request:async x=>x,transactionDone,assertInstallationBinding:(binding,id)=>{if(binding&&binding.deviceId!==id)throw new Error('wrong device')}},
    './canonical.ts':{canonicalRecordSchema},'./verifactu.ts':{aeatHash},'../../../utils/UserFacingError.ts':{UserFacingError},
  },{crypto,IDBKeyRange:{bound:()=>null}})
  return {service,stores}
}

test('failed local commit keeps the retry token and cannot create a usable identity',async()=>{
  const scope=`${tenant}:${subject}:${legacy}`
  const token={scope:'pwa-activation:box',requestId,expectedInstallationId:legacy,recoverForTesting:false}
  const harness=ledgerHarness({bindings:{[token.scope]:token}},true)
  await assert.rejects(harness.service.persistFiscalIdentity('box',{installation:{id:legacy}},scope,device),/write failed/)
  assert.equal(await harness.service.readFiscalIdentity('box'),null)
  assert.equal(harness.stores.get('bindings').get(token.scope).requestId,requestId)
  assert.equal(harness.stores.get('cursors').size,0)
})

test('an identity with missing cursor or orphaned number cursors remains blocked, never resets its chain',async()=>{
  const scope=`${tenant}:${subject}:${legacy}`
  const harness=ledgerHarness({bindings:{[scope]:{scope,deviceId:device}}})
  await assert.rejects(harness.service.assertFiscalLedgerValid(scope,device),/incompleto/)
  const intact=ledgerHarness({bindings:{[scope]:{scope,deviceId:device}},cursors:{[scope]:{scope,position:0,previous:null}}})
  await intact.service.assertFiscalLedgerValid(scope,device)
  intact.stores.get('numbers').set('orphan',{key:`${scope}:BCN-C1-1-2026-S`,lastNumber:10})
  await assert.rejects(intact.service.assertFiscalLedgerValid(scope,device),/incompleto/)
  const lost=ledgerHarness({entries:{record:{id:'record',scope}}})
  await assert.rejects(lost.service.persistFiscalIdentity('box',{},scope,device),/no se puede reiniciar/)
  assert.equal(lost.stores.get('cursors').size,0)
})

test('ledger validation checks AEAT hashes and exact cursor identity, not only positions',async()=>{
  const scope=`${tenant}:${subject}:${legacy}`
  const system={NombreRazon:'Productor SL',NIF:'B12345678',NombreSistemaInformatico:'Tickit',IdSistemaInformatico:'TK',Version:'1',NumeroInstalacion:'BCN-C1-1',TipoUsoPosibleSoloVerifactu:'S',TipoUsoPosibleMultiOT:'S',IndicadorMultiplesOT:'S'}
  const built=await createAltaRecord({invoice:{issuerNif:'B12345678',seriesAndNumber:'BCN-C1-1-2026-S/1',issueDate:'02-10-2026'},issuerName:'Bar SL',type:'F2',description:'Venta',details:[{Impuesto:'01',ClaveRegimen:'01',CalificacionOperacion:'S1',TipoImpositivo:'21.00',BaseImponibleOimporteNoSujeto:'10.00',CuotaRepercutida:'2.10'}],system,previous:null,generatedAt:'2026-10-02T10:00:00+02:00',environment:'test'})
  const entry={id:requestId,scope,record:{idempotencyKey:requestId,tenantId:tenant,fiscalSubjectId:subject,installationId:legacy,deviceId:device,environment:'production',chainPosition:1,previous:null,hash:built.hash,canonicalRecord:built.canonicalRecord,generatedAt:'2026-10-02T10:00:00+02:00'},invoice:{series:'BCN-C1-1-2026-S',number:1}}
  const cursor={scope,position:1,previous:{issuerNif:'B12345678',seriesAndNumber:'BCN-C1-1-2026-S/1',issueDate:'02-10-2026',hash:built.hash}}
  const harness=ledgerHarness({bindings:{[scope]:{scope,deviceId:device}},cursors:{[scope]:cursor},entries:{[requestId]:entry},numbers:{[`${scope}:BCN-C1-1-2026-S`]:{key:`${scope}:BCN-C1-1-2026-S`,lastNumber:1}},delivery:{[requestId]:{state:'LOCAL_PENDING'}}})
  await harness.service.assertFiscalLedgerValid(scope,device,false,'BCN-C1-1')
  cursor.previous.seriesAndNumber='WRONG/1'
  await assert.rejects(harness.service.assertFiscalLedgerValid(scope,device,false,'BCN-C1-1'),/incompleto/)
  cursor.previous.seriesAndNumber='BCN-C1-1-2026-S/1'
  entry.record.canonicalRecord.RegistroAlta.FechaHoraHusoGenRegistro='2026-10-02T10:01:00+02:00'
  await assert.rejects(harness.service.assertFiscalLedgerValid(scope,device,false,'BCN-C1-1'),/incompleto/)
})
