import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {compileComponent} from './helpers/component-harness.mjs'

const source=readFileSync(new URL('../src/lib/offlineStore.ts',import.meta.url),'utf8')
function store(){
  const values=new Map();let route='pos'
  const localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}
  const exports=compileComponent(source,{
    './observability.ts':{reportOperationError:()=>undefined},
    '../features/offline/services/offlineQueueState.ts':{},
    '../app/app-routes':{getAppRoute:()=>route},
  },{window:{localStorage},Date,JSON})
  return {exports,values,setRoute:value=>{route=value}}
}
const context={tenantId:'tenant',venueId:'venue',userId:'user',deviceId:'device',role:'cashier'}
const config={tenantEnabled:true,venueEnabled:true,sensitivity:'normal'}
test('authorized cached config never leaks across tenant, venue, route, device or user',()=>{
  const {exports:api,setRoute}=store()
  assert.equal(api.getCachedAssistConfiguration(context),undefined)
  api.saveCachedAssistConfiguration(context,config)
  assert.equal(api.getCachedAssistConfiguration(context).venueEnabled,true)
  for(const field of ['tenantId','venueId','userId','deviceId']) assert.equal(api.getCachedAssistConfiguration({...context,[field]:'other'}),undefined)
  setRoute('crm');assert.equal(api.getCachedAssistConfiguration(context),undefined)
})
test('unknown/corrupted config fails closed and journal stays bounded/secondary',()=>{
  const {exports:api,values}=store()
  api.saveCachedAssistConfiguration(context,config)
  const key=[...values.keys()][0];values.set(key,JSON.stringify({...config,sensitivity:'invalid'}))
  assert.equal(api.getCachedAssistConfiguration(context),undefined)
  const events=Array.from({length:200},(_,i)=>({key:`key${i}`,episodeId:`episode${i}`,startedAt:new Date().toISOString(),state:'active'}))
  api.saveAssistJournal(context,events)
  assert.equal(api.getAssistJournal(context).length,128)
  assert.equal(api.getOfflineQueue().length,0)
  api.saveCachedAssistConfiguration(context,{...config,tenantEnabled:false})
  assert.equal(api.getCachedAssistConfiguration(context).tenantEnabled,false)
})
