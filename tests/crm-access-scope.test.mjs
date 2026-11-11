import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent } from './helpers/component-harness.mjs'

const serviceSource = readFileSync(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')

const edgeSource = readFileSync(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant-a', userId: 'owner', role: 'owner' }
const flush = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))

function queryClient(tables, calls) {
  return {
    from(table) {
      const call = { table, filters: {} }
      calls.push(call)
      let single = false
      return {
        select(_columns, options) { call.head = options?.head === true; return this },
        update(values) { call.update = values; return this },
        delete() { call.delete = true; return this },
        eq(key, value) { call.filters[key] = value; return this },
        neq(key, value) { call.exclude = [key, value]; return this },
        in(key, values) { call.include = [key, values]; return this },
        order() { return this },
        maybeSingle() { single = true; return this },
        single() { single = true; return this },
        then(resolve) {
          const matches = row => Object.entries(call.filters).every(([key, value]) => row[key] === value)
            && (!call.exclude || row[call.exclude[0]] !== call.exclude[1])
            && (!call.include || call.include[1].includes(row[call.include[0]]))
          const rows = (tables[table] ?? []).filter(matches)
          if (call.delete) tables[table] = (tables[table] ?? []).filter(row => !matches(row))
          if (call.update) rows.forEach(row => Object.assign(row, call.update))
          if (call.head) return Promise.resolve(resolve({ count: rows.length, data: null, error: null }))
          return Promise.resolve(resolve({ data: single ? rows[0] ?? null : rows, error: null }))
        },
      }
    },
  }
}

test('access queries only selected venue devices and accounts, reuses layout venues and rejects unassigned manager devices', async () => {
  const calls = []
  const client = queryClient({ devices: [
    { id: 'device-a', tenant_id: 'tenant-a', venue_id: 'venue-a', device_mode: 'checkout' },
    { id: 'device-b', tenant_id: 'tenant-a', venue_id: 'venue-b', device_mode: 'checkout' },
    { id: 'foreign', tenant_id: 'tenant-b', venue_id: 'venue-a', device_mode: 'checkout' },
    { id: 'kds', tenant_id: 'tenant-a', venue_id: 'venue-a', device_mode: 'kds' },
  ] }, calls)
  let allowedVenueIds = ['venue-a']
  client.functions = { async invoke(name, { body }) {
    calls.push({ name, body })
    return { data: { allowedVenueIds, deviceAccounts: [{ deviceId: 'device-a', email: 'device@example.test' }], users: [
      { id: 'owner', role: 'owner', venueIds: [] },
      { id: 'manager-a', role: 'manager', venueIds: ['venue-a'] },
      { id: 'manager-b', role: 'manager', venueIds: ['venue-b'] },
    ] }, error: null }
  } }
  const { loadCrmAccessData } = compileComponent(serviceSource, {
    '../../../../utils/UserFacingError.ts': { UserFacingError: Error },
    '../../../../lib/tax': {}, '../../../../lib/operationalDay': {},
    '../../../../services/backendService': { requireSupabase: () => client },
  })
  const data = await loadCrmAccessData(context, 'venue-a')
  assert.deepEqual(calls[0].filters, { tenant_id: 'tenant-a', venue_id: 'venue-a' })
  assert.deepEqual(plain(calls[1].body), { action: 'list', tenantId: 'tenant-a', venueId: 'venue-a' })
  assert.equal(calls.length, 2)
  assert.deepEqual(Array.from(data.devices, device => device.id), ['device-a'])
  assert.equal(data.devices[0].account.email, 'device@example.test')
  assert.deepEqual(Array.from(data.users, user => user.id), ['owner', 'manager-a'])
  allowedVenueIds = ['venue-b']
  assert.equal((await loadCrmAccessData({ ...context, role: 'manager' }, 'venue-a')).devices.length, 0)
  calls.length = 0
  assert.deepEqual(plain(await loadCrmAccessData(context, '')), { devices: [], users: [] })
  assert.equal(calls.length, 0)
})

function edgeFixture({ role = 'owner', extraDevices = 0, pendingPayment = false } = {}) {
  const calls = []
  const usersRequested = []
  const authUpdates = []
  const authDeletes = []
  const rpcCalls = []
  let maxConcurrent = 0
  let concurrent = 0
  const tables = {
    tenants: [{ id: 'tenant-a', billing_activation_required: pendingPayment }],
    profiles: [{ id: 'owner', is_superadmin: false }],
    tenant_memberships: [
      { tenant_id: 'tenant-a', user_id: 'owner', role, is_active: true },
      ...['a', 'b'].flatMap(suffix => [
        { tenant_id: 'tenant-a', user_id: `manager-${suffix}`, role: 'manager', is_active: true },
        { tenant_id: 'tenant-a', user_id: `cashier-${suffix}`, role: 'cashier', is_active: true },
      ]),
      { tenant_id: 'tenant-b', user_id: 'foreign-owner', role: 'owner', is_active: true },
    ],
    device_user_assignments: ['a', 'b'].map(suffix => ({ tenant_id: 'tenant-a', user_id: `cashier-${suffix}`, venue_id: `venue-${suffix}`, device_id: `device-${suffix}`, is_active: true })),
    manager_venue_assignments: [
      { tenant_id: 'tenant-a', manager_user_id: 'manager-a', venue_id: 'venue-a' },
      { tenant_id: 'tenant-a', manager_user_id: 'manager-a', venue_id: 'venue-b' },
      { tenant_id: 'tenant-a', manager_user_id: 'manager-b', venue_id: 'venue-b' },
      ...(role === 'manager' ? [{ tenant_id: 'tenant-a', manager_user_id: 'owner', venue_id: 'venue-a' }] : []),
    ],
    user_login_leases: [{ user_id: 'cashier-a', expires_at: '2999-01-01', heartbeat_at: '2026-10-16' }],
    venues: ['a', 'b'].map(suffix => ({ id: `venue-${suffix}`, tenant_id: 'tenant-a', is_active: true })),
  }
  for (let index = 0; index < extraDevices; index++) {
    tables.device_user_assignments.push({ tenant_id: 'tenant-a', user_id: `extra-${index}`, venue_id: 'venue-a', device_id: `extra-${index}`, is_active: true })
  }
  const client = queryClient(tables, calls)
  client.auth = {
    async getUser() { return { data: { user: { id: 'owner' } }, error: null } },
    admin: {
      async getUserById(id) {
        usersRequested.push(id)
        maxConcurrent = Math.max(maxConcurrent, ++concurrent)
        await flush()
        concurrent--
        return { data: { user: { id, email: `${id}@example.test`, user_metadata: {} } }, error: null }
      },
      async updateUserById(id, attributes) { authUpdates.push({ id, ...attributes }); return { data: {}, error: null } },
      async deleteUser(id, soft) { authDeletes.push({ id, soft }); return { data: {}, error: null } },
      listUsers() { assert.fail('Access listing must never enumerate project Auth users') },
    },
  }
  client.rpc = async (name, args) => {
    rpcCalls.push({ name, args })
    if (name === 'set_manager_venue_assignments') {
      tables.manager_venue_assignments = tables.manager_venue_assignments.filter(row => row.manager_user_id !== args.p_manager_user_id)
      tables.manager_venue_assignments.push(...args.p_venue_ids.map(venueId => ({ tenant_id: args.p_tenant_id, manager_user_id: args.p_manager_user_id, venue_id: venueId })))
    }
    return { data: args?.p_venue_ids ?? null, error: null }
  }
  let handler
  compileComponent(edgeSource, {
    'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
    '../_shared/billing/service.ts': {}, '../_shared/billing/mollie.ts': {}, '../_shared/billing/env.ts': {},
    '../_shared/platform-tenant-deletion.ts': {},
    '../_shared/billing/schemas.ts': {}, '../_shared/billing/onboarding.ts': {},
    '../_shared/welcome-email.ts': {},
  }, {
    Deno: { env: { get: () => 'test-value' }, serve: callback => { handler = callback } },
    Response, console,
  })
  return {
    calls, usersRequested, authUpdates, authDeletes, rpcCalls, tables,
    get maxConcurrent() { return maxConcurrent },
    request(body = {}) {
      return handler(new Request('https://example.test', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ action: 'list', tenantId: 'tenant-a', ...body }) }))
    },
  }
}

test('unpaid owners cannot create users or venues through the service-role Edge API', async () => {
  const fixture = edgeFixture({ pendingPayment: true })
  for (const action of ['list', 'create-venue', 'create-device-account']) {
    const reply = await fixture.request({ action })
    assert.equal(reply.status, 403)
    assert.match((await reply.json()).error, /Mi Plan/)
  }
  assert.equal(fixture.usersRequested.length, 0)
})

test('edge denies manager requests outside assigned venue and never exposes management accounts', async () => {
  const denied = edgeFixture({ role: 'manager' })
  assert.equal((await denied.request({ venueId: 'venue-b' })).status, 403)
  assert.equal(denied.usersRequested.length, 0)
  const allowed = edgeFixture({ role: 'manager' })
  const data = await (await allowed.request({ venueId: 'venue-a' })).json()
  assert.deepEqual(data.users, [])
  assert.deepEqual(data.allowedVenueIds, ['venue-a'])
  assert.deepEqual(allowed.usersRequested, ['cashier-a'])
  assert.equal((await allowed.request({ tenantId: 'tenant-b', venueId: 'venue-a' })).status, 403)
})

test('only owners edit or delete other CRM users of their own business', async () => {
  const manager = edgeFixture({ role: 'manager' })
  for (const action of ['update-crm-user', 'delete-crm-user']) {
    assert.equal((await manager.request({ action, userId: 'manager-b', email: 'x@example.test', role: 'gestor' })).status, 403)
  }
  const owner = edgeFixture()
  const update = body => owner.request({ action: 'update-crm-user', email: 'new@example.test', role: 'gestor', ...body })
  assert.equal((await update({ userId: 'owner' })).status, 400)
  assert.equal((await owner.request({ action: 'delete-crm-user', userId: 'owner' })).status, 400)
  // Cashiers are managed with their device; other businesses' users are out of reach.
  assert.equal((await update({ userId: 'cashier-a' })).status, 404)
  assert.equal((await update({ userId: 'foreign-owner' })).status, 404)
  assert.equal((await owner.request({ action: 'delete-crm-user', userId: 'cashier-a' })).status, 404)
  assert.equal((await update({ userId: 'manager-a', role: 'manager', venueIds: ['venue-x'] })).status, 400)
  assert.equal((await update({ userId: 'manager-a', password: 'short' })).status, 400)
  assert.equal(owner.authUpdates.length + owner.authDeletes.length + owner.rpcCalls.length, 0)
})

test('owner changes a CRM user email, password, role and venues', async () => {
  const fixture = edgeFixture()
  const reply = await fixture.request({ action: 'update-crm-user', userId: 'manager-a', email: ' New@Example.test ', password: 'new-password', role: 'gestor' })
  assert.equal(reply.status, 200)
  assert.deepEqual((await reply.json()).user, { id: 'manager-a', email: 'new@example.test', fullName: '', isActive: true, role: 'gestor', venueIds: [] })
  assert.deepEqual(plain(fixture.authUpdates), [{ id: 'manager-a', email: 'new@example.test', email_confirm: true, password: 'new-password' }])
  assert.equal(fixture.tables.tenant_memberships.find(row => row.user_id === 'manager-a').role, 'gestor')
  assert.deepEqual(fixture.tables.manager_venue_assignments.filter(row => row.manager_user_id === 'manager-a'), [])

  // Back to manager with one venue; an unchanged email and empty password leave Auth alone.
  const back = await fixture.request({ action: 'update-crm-user', userId: 'manager-a', email: 'manager-a@example.test', password: '', role: 'manager', venueIds: ['venue-b'] })
  assert.equal(back.status, 200)
  assert.equal(fixture.authUpdates.length, 1)
  assert.deepEqual(plain(fixture.rpcCalls), [{ name: 'set_manager_venue_assignments', args: { p_manager_user_id: 'manager-a', p_tenant_id: 'tenant-a', p_venue_ids: ['venue-b'] } }])
  assert.deepEqual(fixture.tables.manager_venue_assignments.filter(row => row.manager_user_id === 'manager-a').map(row => row.venue_id), ['venue-b'])
})

test('credentials of an account shared with another business are never changed here', async () => {
  const fixture = edgeFixture()
  fixture.tables.tenant_memberships.push({ tenant_id: 'tenant-b', user_id: 'manager-b', role: 'manager', is_active: true })
  const base = { action: 'update-crm-user', userId: 'manager-b', email: 'manager-b@example.test', role: 'gestor' }
  assert.equal((await fixture.request({ ...base, password: 'new-password' })).status, 409)
  assert.equal((await fixture.request({ ...base, email: 'other@example.test' })).status, 409)
  assert.equal(fixture.tables.tenant_memberships.find(row => row.user_id === 'manager-b' && row.tenant_id === 'tenant-a').role, 'manager')
  assert.equal((await fixture.request(base)).status, 200)
  assert.equal(fixture.authUpdates.length, 0)

  // Deleting it removes only this business's access and keeps the account.
  assert.equal((await fixture.request({ action: 'delete-crm-user', userId: 'manager-b' })).status, 200)
  assert.deepEqual(fixture.tables.tenant_memberships.filter(row => row.user_id === 'manager-b').map(row => row.tenant_id), ['tenant-b'])
  assert.equal(fixture.authDeletes.length, 0)
})

test('deleting a CRM user removes its access and soft-deletes its own account', async () => {
  const fixture = edgeFixture()
  assert.equal((await fixture.request({ action: 'delete-crm-user', userId: 'manager-a' })).status, 200)
  assert.equal(fixture.tables.tenant_memberships.some(row => row.user_id === 'manager-a'), false)
  assert.equal(fixture.tables.manager_venue_assignments.some(row => row.manager_user_id === 'manager-a'), false)
  assert.equal(fixture.tables.manager_venue_assignments.some(row => row.manager_user_id === 'manager-b'), true)
  assert.deepEqual(plain(fixture.authDeletes), [{ id: 'manager-a', soft: true }])
})
