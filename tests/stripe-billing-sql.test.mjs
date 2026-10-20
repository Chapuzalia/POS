import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { billingIds as x, billingMigration, createBillingDb } from './helpers/billing-db.mjs'

test('billing migration satisfies expand safety and preserves legacy manual assignments', async t => {
  const result = analyzeMigration(billingMigration)
  assert.deepEqual(result, [])
  const { db } = await createBillingDb(t)
  assert.equal((await db.query('select count(*)::int n from billing_accounts where source=\'manual\'')).rows[0].n, 2)
  assert.deepEqual((await db.query('select feature_key from tenant_feature_assignments order by feature_key')).rows.map(row => row.feature_key), ['production','restaurant'])
  assert.equal((await db.query('select count(*)::int n from billing_price_versions')).rows[0].n, 0)
})

test('RLS isolates invoices and accounts, managers and cashiers cannot read financial data or call transitions', async t => {
  const { db } = await createBillingDb(t)
  await db.query("insert into billing_invoices(stripe_invoice_id,tenant_id,status,currency,amount_due_cents,amount_paid_cents,created_at) values('in_owner',$1,'paid','eur',100,100,now()),('in_other',$2,'paid','eur',100,100,now())",[x.tenant,x.other])
  await db.exec(`select set_config('test.uid','${x.owner}',false); set role authenticated;`)
  assert.deepEqual((await db.query('select tenant_id from billing_accounts')).rows.map(row => row.tenant_id), [x.tenant])
  assert.deepEqual((await db.query('select stripe_invoice_id from billing_invoices')).rows.map(row => row.stripe_invoice_id), ['in_owner'])
  await assert.rejects(db.query('select billing_transition($1,$2)', ['settings',JSON.stringify({tenantId:x.other,graceDays:0})]), /BILLING_FORBIDDEN/)
  await assert.rejects(db.query('update billing_accounts set grace_days=0'), /permission denied/)
  await db.exec(`reset role; update tenant_memberships set role='manager' where user_id='${x.owner}'; set role authenticated;`)
  assert.equal((await db.query('select count(*)::int n from billing_accounts')).rows[0].n, 0)
})

test('immutable catalog versions survive new general tariffs and reject mutation', async t => {
  const { db, transition } = await createBillingDb(t)
  const product = { key:'base',kind:'plan',name:'Base',description:'',scope:'tenant',featureKey:null,resource:null,active:true,sortOrder:0 }
  const version = {interval:'month',amountCents:10000,features:['restaurant'],limits:{venues:2,devices:5},included:{},maximum:null,requires:[]}
  const first = await transition('catalog_save',{actorId:x.owner,product,version,reason:'Test'})
  await transition('catalog_save',{actorId:x.owner,product,version:{...version,amountCents:15000},reason:'New tariff'})
  assert.equal((await db.query('select amount_cents from billing_price_versions where id=$1',[first.id])).rows[0].amount_cents,10000)
  await assert.rejects(db.query('update billing_price_versions set amount_cents=1 where id=$1',[first.id]), /BILLING_IMMUTABLE_VERSION/)
})

async function quote(transition, patch={}) {
  return transition('quote',{tenantId:x.tenant,actorId:x.owner,revision:0,kind:'change',contract:{},restoreContract:null,timing:'immediate',stripeParams:{},preview:{amountDueCents:10},reason:'Test',prorationDate:123,...patch})
}
test('cross-terminal apply serialization, stale quotes and immutable actor ownership', async t => {
  const { transition } = await createBillingDb(t)
  const a=await quote(transition), b=await quote(transition)
  await assert.rejects(transition('apply_claim',{tenantId:x.tenant,actorId:x.stranger,operationId:a.id}), /BILLING_FORBIDDEN/)
  const first=await transition('apply_claim',{tenantId:x.tenant,actorId:x.owner,operationId:a.id})
  assert.equal(first.status,'applying')
  assert.equal((await transition('apply_claim',{tenantId:x.tenant,actorId:x.owner,operationId:a.id})).id,a.id)
  await assert.rejects(transition('apply_claim',{tenantId:x.tenant,actorId:x.owner,operationId:b.id}), /billing_operations_one_inflight_idx/)
  await assert.rejects(quote(transition,{revision:10}), /BILLING_STALE/)
})

test('webhook duplicates, failures and retries keep one persisted event', async t => {
  const { db,transition }=await createBillingDb(t)
  const event={id:'evt_test',type:'invoice.paid',created:10,customer:'cus_test'}
  assert.equal((await transition('event_claim',event)).claimed,true)
  await assert.rejects(transition('event_claim',event), /BILLING_EVENT_BUSY/)
  await transition('event_finish',{id:event.id,status:'failed',error:'RETRY'})
  assert.equal((await transition('event_claim',event)).claimed,true)
  await transition('event_finish',{id:event.id,status:'completed'})
  assert.equal((await transition('event_claim',event)).claimed,false)
  assert.equal((await db.query('select attempts from billing_stripe_events')).rows[0].attempts,2)
})

test('fenced reconciliation commits atomically and closes venue default-true access', async t => {
  const { db,transition }=await createBillingDb(t)
  const claim=await transition('sync_claim',{tenantId:x.tenant})
  await assert.rejects(transition('sync_claim',{tenantId:x.tenant}), /BILLING_SYNC_BUSY/)
  const contract={features:['restaurant','production'],limits:{venues:2,devices:5},addons:[{featureKey:'production',scope:'venue',venueIds:[x.venue]}]}
  const snapshot={tenantId:x.tenant,token:claim.token,customerId:'cus_test',subscriptionId:'sub_test',status:'active',contract,paymentStatus:'paid'}
  await assert.rejects(transition('sync_commit',{...snapshot,token:'00000000-0000-4000-8000-000000000001'}), /BILLING_STALE_SYNC/)
  await transition('sync_commit',snapshot)
  assert.deepEqual((await db.query('select venue_id,is_enabled from venue_addon_assignments order by venue_id')).rows,[{venue_id:x.venue,is_enabled:true},{venue_id:x.venueB,is_enabled:false}])
  await assert.rejects(db.query('update venue_addon_assignments set is_enabled=true where venue_id=$1',[x.venueB]), /BILLING_VENUE_NOT_CONTRACTED/)
  await db.query('delete from venue_addon_assignments where venue_id=$1',[x.venueB])
  assert.equal((await db.query('select is_enabled from venue_addon_assignments where venue_id=$1',[x.venueB])).rows[0].is_enabled,false)
  await assert.rejects(db.query('update tenants set max_devices=100 where id=$1',[x.tenant]), /BILLING_USE_COMMERCIAL_CHANGE/)
  await db.query('insert into venues(id,tenant_id) values($1,$2)',['30000000-0000-4000-8000-000000000003',x.tenant])
  assert.equal((await db.query('select is_enabled from venue_addon_assignments where venue_id=$1',['30000000-0000-4000-8000-000000000003'])).rows[0].is_enabled,false)
  await db.query("select set_config('test.uid',$1,false)",[x.owner])
  assert.ok((await db.query('select get_current_billing_venue_features($1,$2) features',[x.tenant,x.venue])).rows[0].features.includes('production'))
  assert.ok(!(await db.query('select get_current_billing_venue_features($1,$2) features',[x.tenant,x.venueB])).rows[0].features.includes('production'))
  await assert.rejects(db.query('select get_current_billing_venue_features($1,$2)',[x.other,x.venue]), /BILLING_VENUE_FORBIDDEN/)
})

test('failed sync and payment failure preserve persisted operational rights', async t => {
  const { db,transition }=await createBillingDb(t)
  const {token}=await transition('sync_claim',{tenantId:x.tenant})
  await transition('sync_fail',{tenantId:x.tenant,token})
  const next=await transition('sync_claim',{tenantId:x.tenant})
  await transition('sync_commit',{tenantId:x.tenant,token:next.token,customerId:'cus_test',subscriptionId:'sub_test',status:'past_due',contract:null,paymentStatus:'open'})
  assert.equal((await db.query('select count(*)::int n from tenant_feature_assignments')).rows[0].n,2)
  assert.equal((await db.query('select status from billing_accounts where tenant_id=$1',[x.tenant])).rows[0].status,'past_due')
})

test('20 a sale/cash shift open during downgrade defers access reduction, independently of money and fiscal tables', async t => {
  const {db,transition}=await createBillingDb(t)
  const first={features:['restaurant','production'],limits:{venues:3,devices:5},addons:[],recurringCents:15000}
  let claim=await transition('sync_claim',{tenantId:x.tenant})
  const snapshot={tenantId:x.tenant,customerId:'cus_test',subscriptionId:'sub_test',status:'active',paymentStatus:'paid'}
  await transition('sync_commit',{...snapshot,token:claim.token,contract:first})
  await db.query('insert into cash_sessions(id,tenant_id,status) values($1,$2,$3)',['40000000-0000-4000-8000-000000000001',x.tenant,'open'])
  const reduced={...first,features:['restaurant'],recurringCents:10000}
  claim=await transition('sync_claim',{tenantId:x.tenant})
  await transition('sync_commit',{...snapshot,token:claim.token,contract:reduced})
  const account=(await db.query('select contract,billed_contract,sync_error from billing_accounts where tenant_id=$1',[x.tenant])).rows[0]
  assert.deepEqual(account.contract.features,['restaurant','production'])
  assert.equal(account.billed_contract.recurringCents,10000)
  assert.equal(account.sync_error,'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE')
  assert.equal((await db.query('select status from cash_sessions')).rows[0].status,'open')
  await db.exec("update cash_sessions set status='closed'")
  claim=await transition('sync_claim',{tenantId:x.tenant})
  await transition('sync_commit',{...snapshot,token:claim.token,contract:reduced})
  assert.deepEqual((await db.query('select contract from billing_accounts where tenant_id=$1',[x.tenant])).rows[0].contract.features,['restaurant'])
})

test('venue scoping also filters legacy aliases before normalization can re-enable a paid addon', async t => {
  const {db,transition}=await createBillingDb(t)
  await db.exec("insert into platform_features(key,name) values('promotions','Promotions'),('discounts','Legacy discounts')")
  const {token}=await transition('sync_claim',{tenantId:x.tenant})
  const contract={features:['promotions','discounts'],limits:{venues:3,devices:5},addons:[{featureKey:'promotions',scope:'venue',venueIds:[x.venue]}]}
  await transition('sync_commit',{tenantId:x.tenant,token,customerId:'cus_test',subscriptionId:'sub_test',status:'active',contract,paymentStatus:'paid'})
  await db.query("select set_config('test.uid',$1,false)",[x.owner])
  assert.deepEqual((await db.query('select get_current_billing_venue_features($1,$2) features',[x.tenant,x.venueB])).rows[0].features,[])
})
