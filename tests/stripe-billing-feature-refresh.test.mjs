import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { compileComponent } from './helpers/component-harness.mjs'
import { normalizeTenantFeatures } from '../src/features/platform/tenantFeatureAccess.ts'

const source=await readFile(new URL('../src/services/posService.ts',import.meta.url),'utf8')
const start=source.indexOf('export async function loadTenantFeatures(')
const snippet=source.slice(start,source.indexOf('export async function loginTenant(',start))

test('feature refresh reads persisted venue rights once and preserves the legacy fallback only for missing RPCs',async()=>{
  const calls=[]
  let missing=false
  const supabase={rpc:async(name,params)=>{
    calls.push({name,params})
    if(name==='get_current_billing_venue_features'&&missing)return {data:null,error:{code:'PGRST202'}}
    return {data:name==='get_current_billing_venue_features'?['restaurant']:['restaurant','production'],error:null}
  }}
  const {loadTenantFeatures}=compileComponent(snippet,{}, {supabase,normalizeTenantFeatures})
  assert.deepEqual([...(await loadTenantFeatures('tenant','venue'))],['restaurant'])
  assert.equal(calls.length,1)
  assert.equal(calls[0].params.p_venue_id,'venue')
  missing=true
  assert.deepEqual([...(await loadTenantFeatures('tenant','venue'))],['restaurant','production'])
  assert.deepEqual(calls.slice(1).map(call=>call.name),['get_current_billing_venue_features','get_current_tenant_features'])
  assert.equal(calls.some(call=>call.name.includes('stripe')),false)
})
