import test from 'node:test'
import assert from 'node:assert/strict'
import { addCashDenomination, cashDenominationsCents } from '../src/components/modals/cash-payment.ts'

test('incluye monedas de 50 centimos, 1 euro y 2 euros', () => {
  assert.deepEqual(cashDenominationsCents.slice(0, 3), [50, 100, 200])
})

test('la primera denominacion sustituye el importe exacto inicial', () => {
  assert.equal(addCashDenomination(300, 500, true), 500)
})

test('las denominaciones se acumulan y diez billetes de 5 suman 50 euros', () => {
  let delivered = 0
  for (let index = 0; index < 10; index += 1) delivered = addCashDenomination(delivered, 500, false)
  assert.equal(delivered, 5000)
})

test('permite combinar monedas y billetes', () => {
  const delivered = [2000, 500, 200, 50].reduce((total, amount) => addCashDenomination(total, amount, false), 0)
  assert.equal(delivered, 2750)
})
