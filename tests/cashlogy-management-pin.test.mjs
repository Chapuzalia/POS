import assert from 'node:assert/strict'

import test from 'node:test'

import { validateCashlogyManagementPin } from '../src/features/local-printing/cashlogy/cashlogyManagementPin.ts'

test('el PIN de gestión Cashlogy acepta únicamente 1988', () => {
  assert.equal(validateCashlogyManagementPin('1988'), true)
  assert.equal(validateCashlogyManagementPin('1987'), false)
  assert.equal(validateCashlogyManagementPin(''), false)
  assert.equal(validateCashlogyManagementPin('01988'), false)
})
