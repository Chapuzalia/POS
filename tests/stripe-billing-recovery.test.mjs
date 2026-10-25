import assert from 'node:assert/strict'
import test from 'node:test'

import { createBillingService } from './helpers/billing-service.mjs'
import { billingIds as x } from './helpers/billing-db.mjs'

const operation = async (db,id) => (await db.query('select * from billing_operations where id=$1',[id])).rows[0]

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
