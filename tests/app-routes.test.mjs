import test from 'node:test'
import assert from 'node:assert/strict'
import { getRequiredAppRoute } from '../src/app/app-permissions.ts'
import { getAppRoute, getAppRoutePath } from '../src/app/app-routes.ts'

test('route resolution keeps POS as the fallback', () => {
  assert.equal(getAppRoute('/'), 'pos')
  assert.equal(getAppRoute('/crm/'), 'crm')
  assert.equal(getAppRoute('/superadmin'), 'superadmin')
  assert.equal(getAppRoutePath('pos'), '/')
  assert.equal(getAppRoutePath('crm'), '/crm')
  assert.equal(getAppRoutePath('superadmin'), '/superadmin')
})
test('role chooses the required app route', () => {
  assert.equal(getRequiredAppRoute({ role: 'cashier' }), 'pos')
  assert.equal(getRequiredAppRoute({ role: 'admin' }), 'crm')
  assert.equal(getRequiredAppRoute({ role: 'superadmin' }), 'superadmin')
})
