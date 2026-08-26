import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateCashlogyManagementPin } from '../src/features/local-printing/cashlogy/cashlogyManagementPin.ts'

test('el PIN de gestión Cashlogy acepta únicamente 1988', () => {
  assert.equal(validateCashlogyManagementPin('1988'), true)
  assert.equal(validateCashlogyManagementPin('1987'), false)
  assert.equal(validateCashlogyManagementPin(''), false)
  assert.equal(validateCashlogyManagementPin('01988'), false)
})

test('retirar y vaciar solicitan autorización antes de abrir sus vistas', async () => {
  const modal = await readFile(new URL('../src/features/local-printing/components/CashlogyMachineModal.tsx', import.meta.url), 'utf8')

  assert.match(modal, /action\.id === 'withdraw'\) requestProtectedAction\('withdraw'\)/)
  assert.match(modal, /action\.id === 'empty'\) requestProtectedAction\('empty'\)/)
  assert.match(modal, /<NumericKeypadModal[\s\S]*password/)
  assert.match(modal, /PIN incorrecto/)
})

test('el contenido y los totales derivados del stacker permanecen ocultos sin PIN', async () => {
  const modal = await readFile(new URL('../src/features/local-printing/components/CashlogyMachineModal.tsx', import.meta.url), 'utf8')

  assert.match(modal, /showStacker \? \(loading && !accounting[\s\S]*stackerTotalCents/)
  assert.match(modal, /showStacker \? \(loading && !accounting[\s\S]*totalCents/)
  assert.match(modal, /showStacker \? row\.stackerCount : '••••'/)
  assert.match(modal, /showStacker \? formatMoney\(row\.valueCents \* \(row\.recyclerCount \+ row\.stackerCount\)\) : '••••'/)
  assert.match(modal, /Mostrar stacker/)
})
