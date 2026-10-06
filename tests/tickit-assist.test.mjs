import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistEngine, assistThresholds, isAssistEnabled, operationalLoad } from '../src/features/assist/engine.ts'
import { buildAssistSnapshot } from '../src/features/assist/snapshot.ts'
import { createAssistScheduler } from '../src/features/assist/scheduler.ts'

const now = Date.parse('2026-10-06T12:00:00Z')
const ago = minutes => new Date(now - minutes * 60_000).toISOString()
const configuration = { tenantEnabled: true, venueEnabled: true, sensitivity: 'normal' }
const order = (patch={}) => ({ id:'order',groupId:'group',tableName:'Mesa 14',zoneId:'zone',openedAt:ago(15),updatedAt:ago(15),guests:2,lineCount:0,pendingUnits:0,readyUnits:0,oldestPendingAt:null,readyAt:null,...patch })
const snapshot = orders => ({configuration,orders,observedAt:ago(0)})

test('effective activation fails closed for all combinations and unknown config/features',()=>{
  for(const tenantEnabled of [false,true]) for(const venueEnabled of [false,true]) {
    assert.equal(isAssistEnabled({...configuration,tenantEnabled,venueEnabled},['tickit_assist']),tenantEnabled&&venueEnabled)
  }
  assert.equal(isAssistEnabled(undefined,['tickit_assist']),false)
  assert.equal(isAssistEnabled(configuration),false)
  assert.equal(isAssistEnabled(configuration,[]),false)
})
test('persistent condition deduplicates, resolves and starts a fresh episode after recurrence',()=>{
  const engine=new AssistEngine()
  const first=engine.evaluate(snapshot([order()]),now)
  assert.equal(first.situations.length,1)
  assert.equal(engine.evaluate(snapshot([order()]),now+60_000).changed.length,0)
  assert.equal(engine.evaluate(snapshot([order({lineCount:1})]),now+120_000).changed[0].state,'resolved')
  const next=engine.evaluate(snapshot([order()]),now+180_000)
  assert.notEqual(next.situations[0].episodeId,first.situations[0].episodeId)
})
test('sensitivity scales conservative first-order and kitchen thresholds',()=>{
  assert.ok(assistThresholds('low').preparationMs>assistThresholds('normal').preparationMs)
  assert.ok(assistThresholds('normal').firstOrderMs>assistThresholds('high').firstOrderMs)
  assert.equal(new AssistEngine().evaluate({...snapshot([order({openedAt:ago(10)})]),configuration:{...configuration,sensitivity:'normal'}},now).situations.length,0)
  assert.equal(new AssistEngine().evaluate({...snapshot([order({openedAt:ago(10)})]),configuration:{...configuration,sensitivity:'high'}},now).situations.length,1)
})
test('eating, waiting kitchen, incomplete/future timestamps never imply unattended table',()=>{
  for(const candidate of [order({lineCount:2}),order({lineCount:2,pendingUnits:4}),order({openedAt:'invalid'}),order({openedAt:ago(-5)})]) {
    assert.equal(new AssistEngine().evaluate(snapshot([candidate]),now).situations.length,0)
  }
  const ready=order({lineCount:2,readyUnits:2,readyAt:ago(10)})
  assert.equal(new AssistEngine().evaluate(snapshot([ready]),now).situations[0].kind,'unattended_table')
})
test('delay groups split orders and excludes completed/cancelled production',()=>{
  const orders=[order({lineCount:2,pendingUnits:2,oldestPendingAt:ago(40)}),order({id:'split',lineCount:2,pendingUnits:3,oldestPendingAt:ago(50)})]
  const result=new AssistEngine().evaluate(snapshot(orders),now)
  assert.equal(result.situations.length,1)
  assert.equal(result.situations[0].metrics.pending_items,5)
  const built=buildAssistSnapshot(configuration,[{id:'a',orderGroupId:'g',status:'open',openedAt:ago(2),updatedAt:ago(1),guestCount:2}], [{id:'line',orderId:'a',servedQuantity:1}],[],[{current_order_line_id:'line',quantity:4,ready_quantity:2,cancelled_quantity:2,created_at:ago(40),updated_at:ago(10)}],ago(0))
  assert.equal(built.orders[0].pendingUnits,0)
  assert.equal(built.orders[0].readyUnits,1)
})
test('overload requires queue and age or sustained growth; isolated counts are insufficient',()=>{
  const engine=new AssistEngine()
  assert.equal(engine.evaluate(snapshot([order({lineCount:2,pendingUnits:30,oldestPendingAt:ago(1)})]),now).situations.length,0)
  assert.equal(engine.evaluate(snapshot([order({lineCount:2,pendingUnits:30,oldestPendingAt:ago(22)})]),now).situations[0].kind,'kitchen_overload')
  const growth=new AssistEngine()
  growth.evaluate(snapshot([order({lineCount:2,pendingUnits:10,oldestPendingAt:ago(16)})]),now-120_000)
  assert.ok(growth.evaluate(snapshot([order({lineCount:2,pendingUnits:20,oldestPendingAt:ago(16)})]),now).situations.some(x=>x.kind==='kitchen_overload'))
})
test('a single old preparation does not age all fresh units in the same group',()=>{
  const built=buildAssistSnapshot(configuration,[{id:'a',orderGroupId:'g',status:'open',openedAt:ago(60),updatedAt:ago(1),guestCount:2}],
    [{id:'old',orderId:'a',servedQuantity:0},{id:'new',orderId:'a',servedQuantity:0}],[],
    [{current_order_line_id:'old',quantity:1,ready_quantity:0,cancelled_quantity:0,created_at:ago(50)},
      {current_order_line_id:'new',quantity:30,ready_quantity:0,cancelled_quantity:0,created_at:ago(1)}],ago(0))
  const result=new AssistEngine().evaluate(built,now)
  assert.ok(result.situations.some(x=>x.kind==='kitchen_delay'))
  assert.equal(result.situations.some(x=>x.kind==='kitchen_overload'),false)
})
test('zone load uses guests/attention/orders without employee ranking',()=>{
  assert.ok(operationalLoad(order(),true)>operationalLoad(order(),false))
  const high=Array.from({length:5},(_,i)=>order({id:`a${i}`,groupId:`g${i}`,zoneId:'a'}))
  const result=new AssistEngine().evaluate(snapshot([...high,order({groupId:'b',zoneId:'b',lineCount:1,guests:1})]),now)
  assert.ok(result.situations.some(x=>x.kind==='floor_imbalance'))
})
test('ACTION cooldown, feedback and checkpoint prevent repeated notifications',()=>{
  const engine=new AssistEngine()
  const data=snapshot([order({openedAt:ago(30)})])
  const first=engine.evaluate(data,now)
  assert.equal(first.notifications.length,1)
  assert.equal(engine.evaluate(data,now+60_000).notifications.length,0)
  engine.feedback(first.situations[0].key,'not_a_problem')
  assert.equal(engine.evaluate(data,now+120_000).situations[0].feedback,'not_a_problem')
  const restored=new AssistEngine(); restored.restore(first.situations,now)
  assert.equal(restored.evaluate(data,now+60_000).notifications.length,0)
  engine.evaluate(snapshot([]),now+180_000)
  assert.equal(engine.evaluate(data,now+240_000).notifications.length,0)
})
test('scheduler coalesces bursts and cancels even callbacks already queued at disable',()=>{
  let next=0,runs=0; const callbacks=new Map(),intervals=new Map()
  const clock={setTimeout:fn=>{callbacks.set(++next,fn);return next},clearTimeout:id=>callbacks.delete(id),setInterval:fn=>{intervals.set(++next,fn);return next},clearInterval:id=>intervals.delete(id),requestIdleCallback:fn=>{callbacks.set(++next,fn);return next},cancelIdleCallback:id=>callbacks.delete(id)}
  const scheduler=createAssistScheduler(()=>runs++,clock)
  scheduler.schedule(); scheduler.schedule(); scheduler.schedule()
  assert.equal(callbacks.size,1)
  const timeout=[...callbacks.values()][0];callbacks.clear();timeout()
  const stale=[...callbacks.values()][0]
  scheduler.stop();stale();scheduler.schedule()
  assert.equal(runs,0);assert.equal(callbacks.size,0);assert.equal(intervals.size,0)
})
