import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { compileComponent } from './helpers/component-harness.mjs'
import { billingIds as ids } from './helpers/billing-db.mjs'

const schemas=compileComponent(await readFile(new URL('../supabase/functions/_shared/billing/schemas.ts',import.meta.url),'utf8'),{'npm:zod@4.4.3':{z}})
test('strict request contracts reject forged prices and fractional or excessive quantities',()=>{
  const input={action:'quote',tenantId:ids.tenant,selection:{planVersionId:ids.owner,addons:[]},exception:null,reason:'Test'}
  assert.equal(schemas.requestSchema.safeParse(input).success,true)
  for(const patch of [{amountCents:1},{stripePriceId:'price_attacker'},{livemode:true},{actorId:ids.stranger}]) assert.equal(schemas.requestSchema.safeParse({...input,...patch}).success,false)
  assert.equal(schemas.selectionSchema.safeParse({...input.selection,addons:[{key:'production',versionId:ids.owner,quantity:0.5,venueIds:[],deviceIds:[]}]}).success,false)
})

test('server authorization rejects other tenants, managers, catalog writes and unauthorized exceptions',async()=>{
  let handler,role='owner',calls=0
  const query=table=>{
    const filters={}
    const result={
      select(){return this},eq(key,value){filters[key]=value;return this},
      async single(){return {data:table==='profiles'?{is_superadmin:false}:null,error:null}},
      async maybeSingle(){return {data:filters.tenant_id===ids.tenant?{role,is_active:true}:null,error:null}},
    }
    return result
  }
  class Service {async detail(){calls++;return {}}async quote(){calls++;return {}}}
  const createClient=(_url,key)=>key==='anon'?{auth:{getUser:async()=>({data:{user:{id:ids.owner}},error:null})}}:{from:query}
  const env={SUPABASE_URL:'http://localhost',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',STRIPE_TEST_SECRET_KEY:'sk_test_fixture',BILLING_APP_URL:'http://localhost:5173'}
  compileComponent(await readFile(new URL('../supabase/functions/billing/index.ts',import.meta.url),'utf8'),{
    'npm:@supabase/supabase-js@2.115.0':{createClient},
    '../_shared/billing/service.ts':{BillingService:Service},
    '../_shared/billing/schemas.ts':schemas,
    '../_shared/billing/stripe.ts':{StripeGateway:class{}},
  },{Deno:{serve:fn=>{handler=fn},env:{get:key=>env[key]}},Request,Response,URL})
  const post=body=>handler(new Request('http://localhost/billing',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify(body)}))
  assert.equal((await post({action:'get',tenantId:ids.other})).status,403)
  role='manager'
  assert.equal((await post({action:'get',tenantId:ids.tenant})).status,403)
  role='owner'
  assert.equal((await post({action:'overview'})).status,403)
  assert.equal((await post({action:'quote',tenantId:ids.tenant,selection:{planVersionId:ids.owner,addons:[]},exception:{freeUnits:{},limits:{},discountBasisPoints:100,customAmounts:{},cycles:null,reason:'Forged concession'},reason:'Unauthorized'})).status,403)
  assert.equal(calls,0)
  assert.equal((await post({action:'get',tenantId:ids.tenant})).status,200)
  assert.equal(calls,1)
})
