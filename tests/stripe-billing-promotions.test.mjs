import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { addMonths, renewalOnOrAfter, resolvePromotions } from '../supabase/functions/_shared/billing/promotions.ts'
import { createBillingService } from './helpers/billing-service.mjs'
import { billingIds as x, billingPromotionsMigration } from './helpers/billing-db.mjs'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { StripeRequestError } from '../supabase/functions/_shared/billing/stripe.ts'

const concession = promotions => ({freeUnits:{},limits:{},discountBasisPoints:0,customAmounts:{},cycles:null,reason:'Cliente acepta precio habitual tras la promociÃ³n',promotions})
const grant = (key='production',patch={}) => ({id:randomUUID(),key,freeUnits:1,start:'immediate',durationUnit:'months',duration:3,consent:'Acuerdo aceptado por el owner, referencia comercial 123',...patch})
const op = async (db,id)=>(await db.query('select * from billing_operations where id=$1',[id])).rows[0]
async function fixture(t) {
  const env=await createBillingService(t)
  await env.activate()
  const clock={at:Math.ceil(Date.now()/1000)+1}
  t.mock.method(Date,'now',()=>clock.at*1000)
  env.stripe.now=clock.at
  env.stripe.previewRecurring=true
  const sub=env.stripe.subscriptions[0]
  sub.billing_cycle_anchor=clock.at-10*86400
  sub.items.data.forEach(item=>{item.current_period_start=clock.at-10*86400;item.current_period_end=addMonths(item.current_period_start,1)})
  await env.service.reconcile(x.tenant)
  const desired={...env.selection,addons:[{key:'production',versionId:env.production.id,quantity:1,venueIds:[x.venue],deviceIds:[]}]}
  const promote=async(promotion=grant())=>{
    const quote=await env.service.quote(x.tenant,x.owner,desired,concession([promotion]),'Oferta autorizada',true)
    await env.service.confirm(x.tenant,x.owner,quote.id)
    return quote
  }
  const advance=async(at,fail=false)=>{clock.at=at;env.stripe.advanceTo(at,fail);await env.service.reconcile(x.tenant)}
  return {...env,clock,desired,promote,advance}
}

test('promotion expand is compatible and calendar months clamp without 30-day arithmetic',()=>{
  assert.deepEqual(analyzeMigration(billingPromotionsMigration),[])
  const january=Date.parse('2028-01-31T12:00:00Z')/1000
  assert.equal(new Date(addMonths(january,1)*1000).toISOString(),'2028-02-29T12:00:00.000Z')
  assert.equal(new Date(addMonths(january,3)*1000).toISOString(),'2028-04-30T12:00:00.000Z')
  assert.equal(renewalOnOrAfter(addMonths(january,2),january,'month'),addMonths(january,2))
  const february=addMonths(january,1)
  assert.equal(renewalOnOrAfter(Date.parse('2028-03-29T00:00:00Z')/1000,february,'month',january),addMonths(january,2))
  const immediate=resolvePromotions([grant('production',{durationUnit:'cycles'})],[],{addons:[{key:'production',quantity:1}]},january+86400,february,'month',january)[0]
  assert.equal(immediate.endsAt,addMonths(january,4))
  const annual=resolvePromotions([grant('production',{durationUnit:'cycles',start:'period_end'})],[],{addons:[{key:'production',quantity:1}]},january,addMonths(january,12),'year',january)[0]
  assert.equal(annual.endsAt,addMonths(january,48))
})

test('immediate free addon activates after Stripe confirmation, keeps subscription and renewals unchanged, restores automatically',async t=>{
  const {service,stripe,db,promote,advance,clock}=await fixture(t)
  const count=stripe.invoices.length,subId=stripe.subscriptions[0].id
  const quote=await promote()
  assert.equal(quote.preview.amountDueCents,0)
  assert.equal(quote.preview.recurringCents,10000)
  assert.equal(quote.preview.afterPromotionCents,11000)
  assert.equal(quote.preview.promotions[0].firstAddonChargeCents,1000)
  assert.equal(quote.preview.promotions[0].firstInvoiceCents,11000)
  assert.equal(stripe.invoices.length,count)
  assert.equal(stripe.subscriptions[0].id,subId)
  assert.equal(stripe.sessions.size,1)
  let account=await service.account(x.tenant)
  assert.equal(account.contract.addons[0].billable,0)
  assert.equal((await op(db,quote.id)).status,'completed')
  assert.equal(account.schedule_operation_id,quote.id)
  assert.equal((await db.query('select is_enabled from venue_addon_assignments where venue_id=$1',[x.venue])).rows[0].is_enabled,true)
  const end=Date.parse(quote.preview.promotions[0].endsAt)/1000
  assert.equal(end,addMonths(clock.at,3))
  for(let at=stripe.subscriptions[0].items.data[0].current_period_end;at<end;at=addMonths(at,1)) {
    await advance(at)
    assert.equal((await service.account(x.tenant)).billed_contract.recurringCents,10000)
    assert.equal(stripe.subscriptions[0].items.data.length,1)
  }
  const beforeEnd=stripe.invoices.length
  await advance(end)
  assert.equal(stripe.invoices.length,beforeEnd,'No invoice or proration at the mid-cycle boundary')
  account=await service.account(x.tenant)
  assert.equal(account.contract.addons[0].billable,1)
  assert.equal(account.contract.recurringCents,11000)
  const firstCharge=Date.parse(quote.preview.promotions[0].firstChargeAt)/1000
  assert.ok(firstCharge>end)
  await advance(firstCharge)
  assert.equal(stripe.subscriptions[0].items.data.find(item=>item.price.id==='price_production').quantity,1)
  assert.ok(stripe.calls.filter(call=>call.path.startsWith('/subscription_schedules/')&&call.params.phases).every(call=>call.params.proration_behavior==='none'&&call.params.phases.every(phase=>phase.proration_behavior==='none')))
})

test('next-renewal activation and immediate complete cycles have distinct dates',async t=>{
  const {service,stripe,desired,promote,advance}=await fixture(t)
  const renewal=stripe.subscriptions[0].items.data[0].current_period_end
  const quote=await promote(grant('production',{start:'period_end',durationUnit:'cycles',duration:3}))
  assert.equal(quote.timing,'period_end')
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  assert.equal(Date.parse(quote.preview.promotions[0].activationAt)/1000,renewal)
  assert.equal(Date.parse(quote.preview.promotions[0].endsAt)/1000,addMonths(renewal,3))
  const planned=(await service.detail(x.tenant,true)).scheduledContract
  assert.equal(planned.exception.promotions[0].id,quote.contract.exception.promotions[0].id)
  const beforeActivation=await service.quote(x.tenant,x.owner,desired,null,'N-1 owner before activation')
  assert.equal(beforeActivation.contract.exception.promotions[0].endsAt,planned.exception.promotions[0].endsAt)
  await service.confirm(x.tenant,x.owner,beforeActivation.id)
  await advance(renewal)
  assert.equal((await service.account(x.tenant)).contract.addons[0].billable,0)
  // A different addon grant can still be previewed while the first schedule runs.
  const account=await service.account(x.tenant)
  const keep=await service.quote(x.tenant,x.owner,desired,null,'Keep agreed promotion')
  assert.equal(keep.contract.exception.promotions[0].endsAt,account.contract.exception.promotions[0].endsAt)
})

test('consent, quantities and immediate unrelated price changes are validated on the server',async t=>{
  const {service,stripe,desired,selection}=await fixture(t)
  await assert.rejects(service.quote(x.tenant,x.owner,desired,concession([grant('production',{consent:''})]),'Missing consent',true),/INVALID_PROMOTION/)
  await assert.rejects(service.quote(x.tenant,x.owner,desired,concession([grant('production',{freeUnits:2})]),'Excess',true),/INVALID_PROMOTION_ADDON/)
  await assert.rejects(service.quote(x.tenant,x.owner,selection,concession([grant()]),'Not selected',true),/INVALID_PROMOTION_ADDON/)
  const discount={...concession([grant()]),discountBasisPoints:1000}
  await assert.rejects(service.quote(x.tenant,x.owner,desired,discount,'Unrelated price change',true),/INVALID_PROMOTION_IMMEDIATE_CHANGE/)
  assert.equal(stripe.schedules.size,0)
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
})

test('already contracted addon units may be granted immediately without refunds or unrelated discounts',async t=>{
  const {service,stripe,desired,promote}=await fixture(t)
  const add=await service.quote(x.tenant,x.owner,desired,null,'Existing paid addon')
  await service.confirm(x.tenant,x.owner,add.id)
  const count=stripe.invoices.length
  const quote=await promote()
  assert.equal(quote.preview.amountDueCents,0)
  assert.equal(stripe.invoices.length,count)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,10000)
})

test('calendar changes preserve original grant dates, allow plan and quantity changes, and retire the old economic operation',async t=>{
  const {service,stripe,db,desired,promote,advance,transition}=await fixture(t)
  const first=await promote()
  const original=(await service.account(x.tenant)).contract.exception.promotions[0]
  const catalog=await service.catalog(),product=catalog.products.find(p=>p.key==='base')
  const newPlan=await transition('catalog_save',{actorId:x.owner,product,version:{interval:'month',amountCents:20000,features:['restaurant'],limits:{venues:3,devices:5},included:{},maximum:null,requires:[]},reason:'New plan fixture'})
  await db.query('update billing_price_versions set published=true,stripe_price_id=$1 where id=$2',['price_new',newPlan.id])
  stripe.priceAmounts.set('price_new',20000)
  const quote=await service.quote(x.tenant,x.owner,{...desired,planVersionId:newPlan.id,addons:[{...desired.addons[0],quantity:2}]},null,'Plan and quantity update')
  assert.equal(quote.timing,'period_end')
  assert.equal(quote.contract.exception.promotions[0].endsAt,original.endsAt)
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal(stripe.schedules.size,1)
  assert.equal((await op(db,first.id)).status,'completed')
  await advance(stripe.subscriptions[0].items.data[0].current_period_end)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,21000)
  await advance(original.endsAt)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,22000)
})

for(const immediate of [true,false]) test(`cancellation during promotion (${immediate?'now':'renewal'}) releases calendar without restoration charges or data loss`,async t=>{
  const {service,stripe,db,promote}=await fixture(t)
  await promote()
  const quote=await service.quoteCancel(x.tenant,x.owner,immediate,'Owner cancellation')
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal(stripe.subscriptions[0].schedule,null)
  assert.equal(stripe.subscriptions[0].status,immediate?'canceled':'active')
  assert.equal(stripe.subscriptions[0].cancel_at_period_end,!immediate)
  assert.equal((await service.account(x.tenant)).contract.addons[0].quantity,1)
  assert.equal((await db.query('select count(*)::int n from venues where tenant_id=$1',[x.tenant])).rows[0].n,2)
})

test('duplicate/out-of-order events and payment failure after expiry preserve access and converge on recovery',async t=>{
  const {service,stripe,db,promote,advance}=await fixture(t)
  const quote=await promote()
  await advance(Date.parse(quote.preview.promotions[0].endsAt)/1000)
  await advance(Date.parse(quote.preview.promotions[0].firstChargeAt)/1000,true)
  const event={id:'evt_promo_failed',type:'invoice.payment_failed',created:2,livemode:false,data:{object:{customer:'cus_test'}}}
  await service.processEvent(event);await service.processEvent(event)
  assert.equal((await service.account(x.tenant)).status,'past_due')
  assert.equal((await service.account(x.tenant)).contract.addons[0].quantity,1)
  assert.equal((await service.account(x.tenant)).billed_contract.recurringCents,11000)
  stripe.pay()
  await service.processEvent({...event,id:'evt_recovered',type:'invoice.paid',created:3})
  await service.processEvent({...event,id:'evt_old',created:1})
  assert.equal((await service.account(x.tenant)).status,'active')
  assert.equal((await db.query("select attempts from billing_stripe_events where event_id='evt_promo_failed'")).rows[0].attempts,1)
})

test('lost schedule response recovers with identical idempotency keys; foreign tenants cannot recover it',async t=>{
  const {service,stripe,db,desired}=await fixture(t)
  const quote=await service.quote(x.tenant,x.owner,desired,concession([grant()]),'Recover grant',true)
  const original=stripe.request.bind(stripe)
  let lost=true
  stripe.request=async(method,path,...args)=>{const result=await original(method,path,...args);if(lost&&method==='POST'&&path.startsWith('/subscription_schedules/')){lost=false;throw new Error('lost response')}return result}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/lost response/)
  assert.equal((await op(db,quote.id)).status,'applying')
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  await assert.rejects(service.confirm(x.other,x.stranger,quote.id,true),/NOT_FOUND/)
  await service.confirm(x.tenant,x.owner,quote.id,true)
  assert.equal(stripe.schedules.size,1)
  assert.equal((await service.account(x.tenant)).contract.addons[0].billable,0)
  assert.equal((await op(db,quote.id)).status,'completed')
})

test('definitive schedule creation error frees the operation without access, phases rejection retains recoverability',async t=>{
  const {service,stripe,db,desired}=await fixture(t)
  const original=stripe.request.bind(stripe)
  const quote=await service.quote(x.tenant,x.owner,desired,concession([grant()]),'Rejected grant',true)
  stripe.request=async(method,path,...args)=>{if(path==='/subscription_schedules')throw new StripeRequestError(400,{type:'invalid_request_error'},'req_test');return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STRIPE_HTTP_400/)
  assert.equal((await op(db,quote.id)).status,'failed')
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  stripe.request=original
  const retryQuote=await service.quote(x.tenant,x.owner,desired,concession([grant()]),'Recover rejected phases',true)
  stripe.request=async(method,path,...args)=>{if(method==='POST'&&path.startsWith('/subscription_schedules/'))throw new StripeRequestError(400,{type:'invalid_request_error'},'req_phases');return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,retryQuote.id),/STRIPE_HTTP_400/)
  assert.equal((await op(db,retryQuote.id)).status,'applying')
  assert.equal((await service.account(x.tenant)).contract.addons.length,0)
  stripe.request=original
  await service.confirm(x.tenant,x.owner,retryQuote.id,true)
  assert.equal(stripe.schedules.size,1)
  assert.equal((await op(db,retryQuote.id)).status,'completed')
})

test('older clients retain agreed promotions; explicit withdrawal restores only at renewal',async t=>{
  const {service,stripe,desired,promote,advance}=await fixture(t)
  await promote()
  const before=await service.account(x.tenant)
  const keep=await service.quote(x.tenant,x.owner,desired,null,'N-1 superadmin change',true)
  assert.deepEqual(keep.contract.exception.promotions,before.contract.exception.promotions)
  const remove=await service.quote(x.tenant,x.owner,desired,concession([]),'Withdraw grant',true)
  assert.equal(remove.timing,'period_end')
  await service.confirm(x.tenant,x.owner,remove.id)
  assert.equal((await service.account(x.tenant)).contract.addons[0].billable,0)
  await advance(stripe.subscriptions[0].items.data[0].current_period_end)
  assert.equal((await service.account(x.tenant)).contract.addons[0].billable,1)
})

test('client-supplied promotion dates are replaced and confirmed grants cannot be extended without a new agreement',async t=>{
  const {service,desired,promote,clock}=await fixture(t)
  const quote=await promote(grant('production',{startsAt:1,endsAt:9999999999,consentRecordedAt:'forged'}))
  assert.equal(quote.contract.exception.promotions[0].startsAt,clock.at)
  assert.equal(quote.contract.exception.promotions[0].endsAt,addMonths(clock.at,3))
  assert.notEqual(quote.contract.exception.promotions[0].consentRecordedAt,'forged')
  const exception=structuredClone((await service.account(x.tenant)).contract.exception)
  exception.promotions[0].duration=36
  await assert.rejects(service.quote(x.tenant,x.owner,desired,exception,'Silent extension',true),/IMMUTABLE/)
})

test('confirmation rejects changed Stripe state or invoice estimate before any schedule mutation',async t=>{
  const {service,stripe,desired}=await fixture(t)
  const quote=await service.quote(x.tenant,x.owner,desired,concession([grant()]),'Review',true)
  stripe.priceAmounts.set('price_production',2000)
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STALE_STRIPE_QUOTE/)
  assert.equal(stripe.schedules.size,0)
  stripe.priceAmounts.set('price_production',1000)
  stripe.subscriptions[0].cancel_at_period_end=true
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STALE_STRIPE_QUOTE/)
  assert.equal(stripe.schedules.size,0)
})

test('configured calendar releases automatically and future self-service changes remain possible',async t=>{
  const {service,stripe,desired,promote,advance}=await fixture(t)
  await promote()
  const schedule=stripe.schedules.get(stripe.subscriptions[0].schedule)
  // Process the last standard phase, then its release; no manual unblocking.
  await advance(schedule.phases.at(-1).start_date)
  await advance(schedule.phases.at(-1).end_date)
  assert.equal(stripe.subscriptions[0].schedule,null)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,11000)
  assert.ok(await service.quote(x.tenant,x.owner,desired,null,'After release'))
})

test('different addons expire independently and free units do not discount unrelated lines',async t=>{
  const {service,stripe,db,desired,transition,advance}=await fixture(t)
  const second=await transition('catalog_save',{actorId:x.owner,product:{key:'reservations',kind:'addon',name:'Reservations fixture',description:'',scope:'venue',featureKey:'reservations',resource:null,active:true,sortOrder:2},version:{interval:'month',amountCents:600,features:[],limits:{venues:0,devices:0},included:{},maximum:10,requires:[]},reason:'Second fixture'})
  await db.query('update billing_price_versions set published=true,stripe_price_id=$1 where id=$2',['price_reservations',second.id])
  stripe.priceAmounts.set('price_reservations',600)
  const selected={...desired,addons:[desired.addons[0],{key:'reservations',versionId:second.id,quantity:2,venueIds:[x.venue],deviceIds:[]}]}
  // Start with one paid reservation unit, then make only the newly added unit free.
  const paid=await service.quote(x.tenant,x.owner,{...selected,addons:[{...selected.addons[1],quantity:1}]},null,'Existing paid addon')
  await service.confirm(x.tenant,x.owner,paid.id)
  const quote=await service.quote(x.tenant,x.owner,selected,concession([grant(),grant('reservations',{duration:1})]),'Independent terms',true)
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,10600)
  await advance(Date.parse(quote.preview.promotions.find(p=>p.key==='reservations').endsAt)/1000)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,11200)
  assert.equal((await service.account(x.tenant)).contract.addons.find(a=>a.key==='production').billable,0)
  await advance(Date.parse(quote.preview.promotions.find(p=>p.key==='production').endsAt)/1000)
  assert.equal((await service.account(x.tenant)).contract.recurringCents,12200)
})
