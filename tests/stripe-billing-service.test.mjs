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
