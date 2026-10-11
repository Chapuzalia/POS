import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent } from './helpers/component-harness.mjs'

test('bridge eligibility requires an explicit installation marker and fails closed on missing rows or connectivity errors', async () => {
  const source = readFileSync(new URL('../src/features/fiscal/local/bridgeEligibility.ts',import.meta.url),'utf8')
  let result, filters
  const query = { select(columns) { assert.equal(columns,'bridge_requested'); return this }, eq(key,value) { filters.push([key,value]); return this }, async maybeSingle() { return result } }
  const { fiscalBridgeEligible } = compileComponent(source,{ '../../../lib/supabase.ts': { supabase: { from(table) { assert.equal(table,'fiscal_sif_installations'); filters=[]; return query } } } })
  for (const [response, expected] of [[{data:{bridge_requested:true}},true],[{data:{bridge_requested:false}},false],[{data:{}},false],[{data:null},false],[{data:{bridge_requested:true},error:new Error('offline')},false]]) {
    result=response
    assert.equal(await fiscalBridgeEligible('tenant','installation'),expected)
    assert.deepEqual(filters,[['tenant_id','tenant'],['id','installation']])
  }
})
