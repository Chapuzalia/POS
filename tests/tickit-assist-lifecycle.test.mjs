import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {createCompiledHookRunner,jsxRuntime} from './helpers/component-harness.mjs'
import {AssistEngine,isAssistEnabled} from '../src/features/assist/engine.ts'

const source=readFileSync(new URL('../src/features/assist/AssistIndicator.tsx',import.meta.url),'utf8')
const start=Date.parse('2026-10-06T12:00:00Z')
const context={tenantId:'tenant',venueId:'venue',deviceId:'device',userId:'user',features:['tickit_assist']}
const snapshot={configuration:{tenantEnabled:true,venueEnabled:true,sensitivity:'normal'},contextKey:'tenant:venue',observedAt:new Date(start).toISOString(),orders:[{id:'order',groupId:'group',tableName:'Mesa 14',zoneId:'a',guests:2,openedAt:new Date(start-15*60000).toISOString(),updatedAt:new Date(start-15*60000).toISOString(),lineCount:0,pendingUnits:0,readyUnits:0,readyAt:null,oldestPendingAt:null}]}
function harness(){
  let now=start,resolve;const writes=[],requests=[],tasks=[]
  const runner=createCompiledHookRunner(source,'AssistIndicator',{
    'react/jsx-runtime':jsxRuntime,
    '@heroui/react':{Popover:Object.assign(()=>null,{Content:()=>null,Dialog:()=>null,Heading:()=>null})},
    'lucide-react':{CircleAlert:()=>null,Info:()=>null,ShieldCheck:()=>null,TriangleAlert:()=>null,WifiOff:()=>null,X:()=>null},
    '../../components/ui/Button':{Button:()=>null},
    '../../lib/supabase':{supabase:{rpc:(name,args)=>({abortSignal:signal=>{requests.push({name,args,signal});return new Promise(done=>{resolve=done})}})}},
    '../../lib/offlineStore':{getAssistEpisodes:()=>[],getAssistJournal:()=>[],saveAssistEpisodes:()=>{},saveAssistJournal:(_context,events)=>writes.push([...events])},
    './engine':{AssistEngine,isAssistEnabled},
    './scheduler':{createAssistScheduler:evaluate=>{const task={evaluate,stopped:false};tasks.push(task);return{schedule:()=>{},stop:()=>{task.stopped=true}}}},
  },{Date:{now:()=>now,parse:Date.parse},AbortController,document:{visibilityState:'visible'},window:{setTimeout:()=>1,clearTimeout:()=>{}}})
  return{runner,writes,requests,tasks,advance:ms=>{now+=ms},complete:()=>resolve?.({error:null})}
}
const flush=()=>new Promise(done=>setImmediate(done))

test('offline detections wait for fresh authorized synchronization after reconnect',async()=>{
  const h=harness();h.runner.render({context,snapshot,isOnline:false,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,0)
  h.advance(120000);h.runner.render({context,snapshot,isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,0)
  h.runner.render({context,snapshot:{...snapshot,observedAt:new Date(start+120000).toISOString()},isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,1)
  h.complete();await flush();assert.equal(h.writes.at(-1).length,0);h.runner.unmount()
})
test('deactivation aborts in-flight write and late completion cannot save old journal',async()=>{
  const h=harness();h.runner.render({context,snapshot,isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,1)
  const count=h.writes.length;h.runner.unmount();assert.equal(h.tasks[0].stopped,true);assert.equal(h.requests[0].signal.aborted,true)
  h.complete();await flush();assert.equal(h.writes.length,count)
})
test('busy POS operations postpone analysis/writes and a remote disable forbids reconnect flush',()=>{
  const h=harness();h.runner.render({context,snapshot,isOnline:false,busy:true});h.tasks[0].evaluate();assert.equal(h.writes.length,0)
  h.runner.render({context,snapshot,isOnline:false,busy:false});h.tasks[0].evaluate();assert.ok(h.writes.length>0)
  h.runner.render({context,snapshot:{...snapshot,configuration:{...snapshot.configuration,tenantEnabled:false}},isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,0);h.runner.unmount()
})

test('missing snapshot timestamp cannot authorize an offline journal flush',()=>{
  const h=harness();h.runner.render({context,snapshot:{...snapshot,observedAt:''},isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);h.runner.unmount()
})
test('a snapshot from the previous venue cannot generate or persist situations',()=>{
  const h=harness();h.runner.render({context,snapshot:{...snapshot,contextKey:'tenant:previous-venue'},isOnline:true,busy:false});h.tasks[0].evaluate();assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);h.runner.unmount()
})
