import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { buildContract, changeTiming, commercialState, matchesContract, mayProject, recurringMetrics, stripeItems } from '../supabase/functions/_shared/billing/domain.ts'
import { encodeStripeForm, StripeGateway, verifyStripeSignature } from '../supabase/functions/_shared/billing/stripe.ts'

// Synthetic test tariffs; these are not Tickit's commercial catalogue.
export const products = [
  {key:'base',kind:'plan',name:'Test base',description:'',scope:'tenant',featureKey:null,resource:null,active:true,sortOrder:0},
  ...['production','reservations'].map(key=>({key,kind:'addon',name:key,description:'',scope:'venue',featureKey:key,resource:null,active:true,sortOrder:1})),
  {key:'venues',kind:'addon',name:'Venues',description:'',scope:'tenant',featureKey:null,resource:'venues',active:true,sortOrder:2},
  {key:'devices',kind:'addon',name:'Devices',description:'',scope:'device',featureKey:null,resource:'devices',active:true,sortOrder:3},
]
export const versions = [
  {id:'base_v1',productKey:'base',interval:'month',amountCents:10000,stripePriceId:'price_base',features:['restaurant'],limits:{venues:1,devices:2},included:{},maximum:null,requires:[],published:true},
  ...['production','reservations','venues','devices'].map((key,index)=>({id:`${key}_v1`,productKey:key,interval:'month',amountCents:1000+index*100,stripePriceId:`price_${key}`,features:[],limits:{venues:1,devices:0},included:{},maximum:20,requires:key==='production'||key==='reservations'?['restaurant']:[],published:true})),
]
export const selected = (key,quantity,venueIds=[]) => ({key,quantity,versionId:`${key}_v1`,venueIds,deviceIds:[]})
export const contract = (addons=[],patch={}) => buildContract(products,versions,{planVersionId:'base_v1',addons},patch.exception??null)

test('01 paid onboarding and 02 optional addon aggregate immutable integer-cent lines',()=>{
  assert.equal(contract().recurringCents,10000)
  const next=contract([selected('production',1,['A'])])
  assert.equal(next.recurringCents,11000)
  assert.deepEqual(next.features,['production','restaurant'])
})
test('03 venue assignment and 04 multiple venues aggregate to one subscription',()=>{
  const next=contract([selected('production',2,['A','B']),selected('reservations',2,['A','C']),selected('venues',2)])
  assert.equal(next.limits.venues,3)
  assert.equal(next.lines.length,4)
  assert.equal(next.addons[0].venueIds.length,2)
  assert.throws(()=>contract([selected('production',1,['A','B'])]),/VENUE_QUANTITY/)
})
test('05 upgrading to included units stops duplicate billing without losing assignments',()=>{
  const next=buildContract(products,[...versions,{...versions[0],id:'included_v2',included:{production:2}}],{planVersionId:'included_v2',addons:[selected('production',2,['A','B'])]})
  assert.equal(next.addons[0].billable,0)
  assert.equal(next.lines.length,1)
  assert.deepEqual(next.addons[0].venueIds,['A','B'])
})
test('06 removing included units retains addon feature and bills the supplement',()=>{
  const next=contract([selected('production',2,['A','B'])])
  assert.equal(next.addons[0].billable,2)
  assert.ok(next.features.includes('production'))
})
test('07 device increases are immediate and decreases scheduled, independent of amount',()=>{
  const current=contract([selected('devices',2)])
  assert.equal(changeTiming(current,contract([selected('devices',3)])),'immediate')
  assert.equal(changeTiming(current,contract([selected('devices',1)])),'period_end')
})
test('08 Stripe form contains exact proration date and never floating-point money',()=>{
  const encoded=encodeStripeForm({items:[{id:'si_1',quantity:3}],proration_behavior:'always_invoice',proration_date:1780000000,payment_behavior:'pending_if_incomplete'})
  assert.equal(encoded.get('items[0][quantity]'),'3')
  assert.equal(encoded.get('proration_date'),'1780000000')
  assert.equal(encoded.get('payment_behavior'),'pending_if_incomplete')
})
test('09 scheduled cancellation and 10 failed payment preserve access until confirmed',()=>{
  assert.equal(mayProject('active',true,true),false)
  assert.equal(mayProject('past_due',false,false),false)
  assert.equal(mayProject('canceled',false,true),false)
  assert.equal(commercialState('past_due','2026-01-01T00:00:00Z',14,Date.parse('2026-01-10')),'grace')
  assert.equal(commercialState('past_due','2026-01-01T00:00:00Z',14,Date.parse('2026-02-01')),'restricted')
})
test('11 paid recovery allows projection; active unpaid invoices never do',()=>{
  assert.equal(mayProject('active',false,true),true)
  assert.equal(mayProject('active',false,false),false)
})
test('15 browser prices, duplicate items, negative/fractional quantities and missing dependencies fail closed',()=>{
  for(const quantity of [-1,0.1,NaN,Infinity,100001]) assert.throws(()=>contract([selected('production',quantity)]))
  assert.throws(()=>contract([selected('production',1),selected('production',1)]),/INVALID_ADDON/)
  assert.throws(()=>buildContract(products,versions,{planVersionId:'unknown',addons:[]}),/INVALID_PLAN/)
  assert.throws(()=>buildContract(products,versions.map(row=>row.id==='base_v1'?{...row,features:[]}:row),{planVersionId:'base_v1',addons:[selected('production',1)]}),/PREREQUISITE/)
})
test('17 legacy accounts retain a distinct manual commercial state',()=>{
  assert.equal(commercialState('manual',null,14),'manual')
})
test('18 changing general tariffs does not reprice existing contracts',()=>{
  const current=contract([selected('production',1)])
  const revised=versions.map(row=>({...row,amountCents:row.amountCents*2}))
  buildContract(products,revised,current.selection)
  assert.equal(current.recurringCents,11000)
})
test('19 exception free units, custom amounts and discounts do not change general tariffs',()=>{
  const exception={freeUnits:{production:1},customAmounts:{base:8000},discountBasisPoints:1000,limits:{devices:20},cycles:null,reason:'Test agreement'}
  const next=contract([selected('production',2)],{exception})
  assert.equal(next.recurringCents,8100)
  assert.equal(next.limits.devices,20)
  assert.equal(next.addons[0].billable,1)
  assert.equal(versions[0].amountCents,10000)
})
test('line replacement deletes stale items and matches one consolidated subscription',()=>{
  const next=contract([selected('production',2)])
  const items=stripeItems([{id:'si_old',price:{id:'price_old'},quantity:1}],next.lines)
  assert.deepEqual(items[0],{id:'si_old',deleted:true})
  assert.equal(matchesContract(next.lines.map(line=>({price:{id:line.stripePriceId},quantity:line.quantity})),next),true)
  assert.equal(matchesContract([],next),false)
})
test('MRR/ARR never double-count addons, taxes, trials or manual accounts',()=>{
  const monthly=contract([selected('production',1)])
  const yearly={...monthly,interval:'year',recurringCents:100000}
  const metrics=recurringMetrics([{status:'active',contract:monthly},{status:'past_due',contract:yearly},{status:'trialing',contract:monthly},{status:'manual',contract:null}])
  assert.equal(metrics.arrCents,232000)
  assert.equal(metrics.mrrCents,19333)
})
test('raw-body HMAC validates rotation signatures and rejects tampering, stale timestamps, missing headers',async()=>{
  const now=Date.now(), timestamp=Math.floor(now/1000),secret='whsec_test_only',raw='{"id":"evt_test"}'
  const signature=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex')
  await verifyStripeSignature(raw,`t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`,secret,now)
  await assert.rejects(verifyStripeSignature(raw+' ',`t=${timestamp},v1=${signature}`,secret,now))
  await assert.rejects(verifyStripeSignature(raw,`t=${timestamp},v1=${signature}`,secret,now+301000))
  await assert.rejects(verifyStripeSignature(raw,null,secret,now))
})
test('14 network failure and production keys fail safely without exposing responses',async()=>{
  assert.throws(()=>new StripeGateway('sk_live_never_allowed'),/TEST_KEY_REQUIRED/)
  const offline=new StripeGateway('sk_test_fixture',async()=>{throw new Error('network offline')})
  await assert.rejects(offline.request('GET','/subscriptions/sub_test'),/offline/)
  const gateway=new StripeGateway('sk_test_fixture',async()=>Response.json({livemode:true}))
  await assert.rejects(gateway.request('GET','/customers/cus_test'),/LIVE_MODE_FORBIDDEN/)
})
