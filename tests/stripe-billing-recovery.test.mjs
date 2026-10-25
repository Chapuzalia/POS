import assert from 'node:assert/strict'
import test from 'node:test'
import { StripeGateway, StripeRequestError } from '../supabase/functions/_shared/billing/stripe.ts'
import { createBillingService } from './helpers/billing-service.mjs'
import { billingIds as x, billingRepairMigration } from './helpers/billing-db.mjs'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const rejected = () => new StripeRequestError(400, {type:'invalid_request_error',code:'parameter_unknown',param:'payment_method_types'}, 'req_test')
const operation = async (db,id) => (await db.query('select * from billing_operations where id=$1',[id])).rows[0]

test('Stripe errors classify only definitive rejections and retain no message, body or sensitive fields', async()=>{
  for(const [status,type,outcome] of [[400,'invalid_request_error','rejected'],[401,'authentication_error','rejected'],[403,'permission_error','rejected'],[404,'invalid_request_error','rejected'],[400,'idempotency_error','uncertain'],[409,'invalid_request_error','uncertain'],[429,'rate_limit_error','uncertain'],[500,'api_error','uncertain'],[502,'api_error','uncertain'],[400,null,'uncertain']]) {
    const gateway=new StripeGateway('sk_test_fixture',async()=>Response.json({error:{type,code:'parameter_unknown',param:'payment_method_types',message:'private@example.com',request_log_url:'https://private'}},{status,headers:{'Request-Id':'req_test'}}))
    await assert.rejects(gateway.request('POST','/checkout/sessions',{},'same-key'),error=>{
      assert.equal(error.diagnostic.outcome,outcome)
      assert.equal(error.diagnostic.requestId,'req_test')
      assert.ok(!JSON.stringify(error).includes('private'))
      return true
    })
  }
  const malformed=new StripeGateway('sk_test_fixture',async()=>new Response('bad gateway',{status:400}))
  await assert.rejects(malformed.request('POST','/checkout/sessions'),error=>error.diagnostic.outcome==='uncertain')
  assert.equal(new StripeRequestError(400,{type:'invalid_request_error',code:'idempotency_key_in_use'},'req_test').diagnostic.outcome,'uncertain')
  const retryable=new StripeGateway('sk_test_fixture',async()=>Response.json({error:{type:'invalid_request_error'}},{status:400,headers:{'Stripe-Should-Retry':'true'}}))
  await assert.rejects(retryable.request('POST','/checkout/sessions'),error=>error.diagnostic.outcome==='uncertain')
})

test('Checkout uses Dashboard methods while preserving subscription, tax, metadata and redirect parameters',async t=>{
  const {service,stripe,selection}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Dynamic methods')
  await service.confirm(x.tenant,x.owner,quote.id)
  const call=stripe.calls.find(call=>call.path==='/checkout/sessions')
  assert.equal(Object.hasOwn(call.params,'payment_method_types'),false)
  assert.equal(call.params.mode,'subscription')
  assert.equal(call.params.customer,'cus_test')
  assert.equal(call.params.billing_address_collection,'required')
  assert.deepEqual(call.params.tax_id_collection,{enabled:true})
  assert.deepEqual(call.params.customer_update,{address:'auto',name:'auto'})
  assert.deepEqual(call.params.subscription_data.metadata,call.params.metadata)
  assert.equal(call.params.metadata.tickit_operation_id,quote.id)
  assert.equal(call.params.metadata.tickit_tenant_id,x.tenant)
  assert.equal(call.params.success_url,'http://localhost:5173/crm?billing=success')
  assert.equal(call.params.cancel_url,'http://localhost:5173/crm?billing=cancelled')
  assert.equal(call.idempotencyKey,`tickit:${quote.id}`)
  assert.deepEqual(call.params.line_items,[{price:'price_base',quantity:1}])
})

test('definitive Checkout rejection persists a sanitized error and releases the tenant lock',async t=>{
  const {service,stripe,selection,db}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Rejected checkout')
  const original=stripe.request.bind(stripe)
  stripe.request=async(method,path,...args)=>{if(path==='/checkout/sessions')throw rejected();return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STRIPE_HTTP_400/)
  const failed=await operation(db,quote.id)
  assert.equal(failed.status,'failed')
  assert.equal(failed.result.stripeError.param,'payment_method_types')
  assert.equal((await service.account(x.tenant)).source,'manual')
  assert.equal((await db.query("select count(*)::int n from billing_audit where action='apply_error'")).rows[0].n,1)
  stripe.request=original
  const next=await service.quote(x.tenant,x.owner,selection,null,'Corrected checkout')
  await service.confirm(x.tenant,x.owner,next.id)
  assert.equal(stripe.sessions.size,1)
  await service.confirm(x.tenant,x.owner,quote.id)
  assert.equal(stripe.sessions.size,1)
})

test('lost Checkout response retains the lock and retry recovers the same session and key',async t=>{
  const {service,stripe,selection,db}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Lost response')
  const original=stripe.request.bind(stripe)
  stripe.request=async(method,path,...args)=>{const result=await original(method,path,...args);if(path==='/checkout/sessions')throw new Error('timeout private');return result}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/timeout/)
  assert.equal((await operation(db,quote.id)).status,'applying')
  assert.equal((await operation(db,quote.id)).result.stripeError.outcome,'uncertain')
  const next=await service.quote(x.tenant,x.owner,selection,null,'Must remain blocked')
  await assert.rejects(service.confirm(x.tenant,x.owner,next.id))
  stripe.request=original
  const recovered=await service.confirm(x.tenant,x.owner,quote.id,true)
  assert.equal(recovered.operation.result.checkoutId,[...stripe.sessions.keys()][0])
  assert.equal(stripe.sessions.size,1)
  const calls=stripe.calls.filter(call=>call.path==='/checkout/sessions')
  assert.equal(calls.length,2)
  assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey)
  assert.deepEqual(calls[0].params,calls[1].params)
})

test('a rejection on retry cannot erase the uncertainty of an earlier mutation',async t=>{
  const {service,stripe,selection,db}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Uncertain then rejection')
  const original=stripe.request.bind(stripe)
  stripe.request=async(method,path,...args)=>{if(path==='/checkout/sessions')throw new Error('timeout');return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id))
  stripe.request=async(method,path,...args)=>{if(path==='/checkout/sessions')throw rejected();return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id,true))
  assert.equal((await operation(db,quote.id)).status,'applying')
  await db.query("update billing_operations set created_at=now()-interval '24 hours' where id=$1",[quote.id])
  const count=stripe.calls.length
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id,true),/MANUAL_RECONCILIATION_REQUIRED/)
  assert.equal(stripe.calls.length,count)
})

test('phase rejection after schedule creation retains the block and retries existing schedule idempotently',async t=>{
  const {service,stripe,selection,activate,db}=await createBillingService(t)
  await activate()
  const quote=await service.quote(x.tenant,x.owner,selection,{freeUnits:{},limits:{},discountBasisPoints:1000,customAmounts:{},cycles:null,reason:'Discount'},'Schedule',true)
  const original=stripe.request.bind(stripe)
  stripe.request=async(method,path,...args)=>{if(method==='POST'&&path.startsWith('/subscription_schedules/'))throw rejected();return original(method,path,...args)}
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STRIPE_HTTP_400/)
  assert.equal(stripe.schedules.size,1)
  assert.equal((await operation(db,quote.id)).status,'applying')
  stripe.request=original
  await service.confirm(x.tenant,x.owner,quote.id,true)
  assert.equal(stripe.schedules.size,1)
  assert.equal((await operation(db,quote.id)).status,'scheduled')
})

test('manual reconciliation clears false delinquency, stays stable and preserves a valid quote',async t=>{
  const {service,selection,db,transition}=await createBillingService(t)
  await transition('link_customer',{tenantId:x.tenant,customerId:'cus_test'})
  await db.query('update billing_accounts set delinquent_since=now() where tenant_id=$1',[x.tenant])
  await service.reconcile(x.tenant)
  const clean=await service.account(x.tenant)
  assert.equal(clean.status,'manual')
  assert.equal(clean.delinquent_since,null)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Survives reconciliation')
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).revision,clean.revision)
  await service.confirm(x.tenant,x.owner,quote.id)
})

test('revision changes on commercial changes, not repeated paid or delinquent snapshots',async t=>{
  const {service,stripe,activate,selection,production}=await createBillingService(t)
  await activate()
  const active=await service.account(x.tenant)
  const quote=await service.quote(x.tenant,x.owner,{...selection,addons:[{key:'production',versionId:production.id,quantity:1,venueIds:[x.venue],deviceIds:[]}]},null,'Valid quote')
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).revision,active.revision)
  stripe.subscriptions[0].status='past_due'
  await service.reconcile(x.tenant)
  const overdue=await service.account(x.tenant)
  assert.equal(overdue.revision,active.revision+1)
  assert.ok(overdue.delinquent_since)
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).revision,overdue.revision)
  assert.deepEqual((await service.account(x.tenant)).delinquent_since,overdue.delinquent_since)
  await assert.rejects(service.confirm(x.tenant,x.owner,quote.id),/STALE/)
  stripe.subscriptions[0].status='active'
  await service.reconcile(x.tenant)
  assert.equal((await service.account(x.tenant)).delinquent_since,null)
})

test('error transition fences by tenant and cannot release a recorded resource or completed operation',async t=>{
  const {service,selection,db,transition}=await createBillingService(t)
  const quote=await service.quote(x.tenant,x.owner,selection,null,'Scoped error')
  await transition('apply_claim',{tenantId:x.tenant,actorId:x.owner,operationId:quote.id})
  const data={tenantId:x.tenant,operationId:quote.id,error:rejected().diagnostic,release:true}
  await assert.rejects(transition('apply_error',{...data,tenantId:x.other}),/FORBIDDEN/)
  await db.query('update billing_operations set result=$1 where id=$2',[JSON.stringify({scheduleId:'sub_sched_existing'}),quote.id])
  assert.equal((await transition('apply_error',data)).status,'applying')
  await transition('apply_result',{tenantId:x.tenant,operationId:quote.id,status:'completed',result:{}})
  assert.equal((await transition('apply_error',data)).status,'completed')
})

test('Billing repair remains a compatible expand migration',()=>assert.deepEqual(analyzeMigration(billingRepairMigration),[]))
