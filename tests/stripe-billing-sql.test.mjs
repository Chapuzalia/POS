import assert from 'node:assert/strict'
import test from 'node:test'

import { billingIds as x, createBillingDb } from './helpers/billing-db.mjs'

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
