import assert from 'node:assert/strict'
import test from 'node:test'
import { createBillingService } from './helpers/billing-service.mjs'
import { billingIds as x } from './helpers/billing-db.mjs'

test('checkout onboarding grants no permanent rights before confirmed payment',async t=>{
  const {service,stripe,selection}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Onboarding')
  const first=await service.confirm(x.tenant,x.owner,quote.id)
  assert.ok(first.url.startsWith('https://checkout.stripe.com'))
  assert.equal((await service.account(x.tenant)).source,'manual')
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal(stripe.calls.filter(call=>call.path==='/checkout/sessions').length,1)
  stripe.completeCheckout()
  await service.processEvent({id:'evt_onboard',type:'checkout.session.completed',created:1,livemode:false,data:{object:{customer:'cus_test'}}})
  assert.equal((await service.account(x.tenant)).source,'stripe')
  assert.equal((await service.account(x.tenant)).contract.planName,'Synthetic base')
})
test('addon failure retains old rights, recovery and reversed/duplicate webhook delivery converge to current state',async t=>{
  const {service,stripe,selection,production,activate,db}=await createBillingService(t)
  await activate()
  const desired={...selection,addons:[{key:'production',versionId:production.id,quantity:1,venueIds:[x.venue],deviceIds:[]}]}
  stripe.failPayment=true
  const quote=await service.quote(x.tenant,x.owner,desired,null,'Add production')
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  const mutation=stripe.calls.find(call=>call.method==='POST'&&call.path==='/subscriptions/sub_test')
  assert.equal(mutation.params.payment_behavior,'pending_if_incomplete')
  assert.equal(mutation.params.proration_behavior,'always_invoice')
  assert.equal(mutation.params.proration_date,quote.proration_date)
  stripe.pay()
  const event={id:'evt_paid',type:'invoice.paid',created:100,livemode:false,data:{object:{customer:'cus_test'}}}
  await service.processEvent(event)
  assert.equal((await service.account(x.tenant)).contract.addons[0].billable,1)
  await service.processEvent(event)
  await service.processEvent({...event,id:'evt_old_failed',type:'invoice.payment_failed',created:1})
  assert.equal((await service.account(x.tenant)).status,'active')
  assert.equal((await db.query('select is_enabled from venue_addon_assignments where venue_id=$1',[x.venueB])).rows[0].is_enabled,false)
})
test('downgrade assignments with identical Stripe prices stay unchanged until period boundary',async t=>{
  const {service,stripe,selection,production,activate}=await createBillingService(t)
  await activate()
  const selected={key:'production',versionId:production.id,quantity:1,venueIds:[x.venue],deviceIds:[]}
  const add=await service.quote(x.tenant,x.owner,{...selection,addons:[selected]},null,'Add')
  await service.confirm(x.tenant,x.owner,add.id)
  const move=await service.quote(x.tenant,x.owner,{...selection,addons:[{...selected,venueIds:[x.venueB]}]},null,'Move next period')
  assert.equal(move.timing,'period_end')
  await service.confirm(x.tenant,x.owner,move.id)
  assert.deepEqual((await service.account(x.tenant)).contract.addons[0].venueIds,[x.venue])
  stripe.advancePhase()
  await service.reconcile(x.tenant)
  assert.deepEqual((await service.account(x.tenant)).contract.addons[0].venueIds,[x.venueB])
})
test('cross-tenant assignments are rejected before Stripe requests; uncertain network mutation is recoverable',async t=>{
  const {service,stripe,selection,production,activate}=await createBillingService(t)
  await activate()
  const desired={...selection,addons:[{key:'production',versionId:production.id,quantity:1,venueIds:[x.stranger],deviceIds:[]}]}
  const count=stripe.calls.length
  await assert.rejects(service.quote(x.tenant,x.owner,desired,null,'Foreign'),/FOREIGN_ASSIGNMENT/)
  assert.equal(stripe.calls.length,count)
  desired.addons[0].venueIds=[x.venue]
  const quote=await service.quote(x.tenant,x.owner,desired,null,'Network test')
  const original=stripe.request.bind(stripe)
  stripe.request=async(method,path,...args)=>{if(method==='POST'&&path==='/subscriptions/sub_test')throw new Error('network offline');return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/offline/)
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  stripe.request=original
  await service.confirm(x.tenant,x.owner,quote.id,true)
  assert.equal((await service.account(x.tenant)).contract.addons.length,1)
})
test('scheduled cancellation preserves data and remaining paid operational rights',async t=>{
  const {service,stripe,activate}=await createBillingService(t)
  await activate()
  const quote=await service.quoteCancel(x.tenant,x.owner,false,'Cancel at renewal')
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal((await service.account(x.tenant)).cancel_at_period_end,true)
  stripe.subscriptions[0].status='canceled'
  await service.reconcile(x.tenant)
  const account=await service.account(x.tenant)
  assert.equal(account.status,'canceled')
  assert.equal(account.contract.planName,'Synthetic base')
})

test('temporary commercial limit exceptions expire even when Stripe prices stay identical',async t=>{
  const {service,stripe,selection,activate}=await createBillingService(t)
  await activate()
  const exception={freeUnits:{},limits:{devices:20},discountBasisPoints:0,customAmounts:{},cycles:1,reason:'One cycle'}
  const quote=await service.quote(x.tenant,x.owner,selection,exception,'Temporary capacity',true)
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal((await service.account(x.tenant)).contract.limits.devices,5)
  stripe.advancePhase(1)
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).contract.limits.devices,20)
  stripe.advancePhase(2)
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).contract.limits.devices,5)
})

test('expired pending payment releases the operation without granting unpaid capacity',async t=>{
  const {service,stripe,selection,production,activate,db}=await createBillingService(t)
  await activate()
  stripe.failPayment=true
  const quote=await service.quote(x.tenant,x.owner,{...selection,addons:[{key:'production',versionId:production.id,quantity:1,venueIds:[x.venue],deviceIds:[]}]},null,'Pending expiry')
  await service.confirm(x.tenant,x.owner,quote.id)
  const sub=stripe.subscriptions[0]
  sub.pending_update=null
  sub.latest_invoice.status='void'
  await service.reconcile(x.tenant)
  assert.equal((await db.query('select status from billing_operations where id=$1',[quote.id])).rows[0].status,'expired')
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
})

test('custom price and percentage concession are private to one contract and do not mutate general tariffs',async t=>{
  const {service,stripe,selection,activate,db}=await createBillingService(t)
  await activate()
  const exception={freeUnits:{},limits:{},discountBasisPoints:1000,customAmounts:{base:8000},cycles:null,reason:'Private test agreement'}
  const quote=await service.quote(x.tenant,x.owner,selection,exception,'Commercial exception',true)
  assert.equal(quote.timing,'period_end')
  await service.confirm(x.tenant,x.owner,quote.id)
  stripe.advancePhase()
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).billed_contract.recurringCents,7200)
  assert.equal((await db.query("select amount_cents from billing_price_versions where product_key='base'")).rows[0].amount_cents,10000)
  stripe.subscriptions[0].schedule=null // Completed/released schedule; normal self-service resumes.
  assert.equal((await service.quote(x.tenant,x.owner,selection,null,'Keep agreed terms')).contract.recurringCents,7200)
})

test('new customers cannot select superseded tariffs, while existing contracts retain their negotiated version',async t=>{
  const {service,selection,activate,db,transition}=await createBillingService(t)
  await activate()
  const current=await service.catalog()
  const product=current.products.find(row=>row.key==='base')
  const updated=await transition('catalog_save',{actorId:x.owner,product,version:{interval:'month',amountCents:15000,features:['restaurant'],limits:{venues:3,devices:5},included:{},maximum:null,requires:[]},reason:'New general tariff'})
  await db.query('update billing_price_versions set stripe_price_id=$1,published=true where id=$2',['price_new_base',updated.id])
  await assert.rejects(service.quote(x.other,x.stranger,selection,null,'Old price forgery'), /HISTORICAL_TARIFF/)
  const retained=await service.quote(x.tenant,x.owner,selection,null,'Retain contracted tariff')
  assert.equal(retained.contract.recurringCents,10000)
  assert.equal((await service.account(x.tenant)).billed_contract.recurringCents,10000)
  await transition('catalog_save',{actorId:x.owner,product:{...product,active:false},version:null,reason:'Stop selling to new customers'})
  assert.equal((await service.quote(x.tenant,x.owner,selection,null,'Retain inactive contracted product')).contract.recurringCents,10000)
})
