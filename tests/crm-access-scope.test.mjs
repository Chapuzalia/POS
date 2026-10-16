import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent, createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const serviceSource = readFileSync(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')
const pageSource = readFileSync(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8')
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
        select() { return this },
        eq(key, value) { call.filters[key] = value; return this },
        neq(key, value) { call.exclude = [key, value]; return this },
        in(key, values) { call.include = [key, values]; return this },
        order() { return this },
        maybeSingle() { single = true; return this },
        then(resolve) {
          const rows = (tables[table] ?? []).filter(row =>
            Object.entries(call.filters).every(([key, value]) => row[key] === value)
            && (!call.exclude || row[call.exclude[0]] !== call.exclude[1])
            && (!call.include || call.include[1].includes(row[call.include[0]])),
          )
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
    '../../shared/services/crmServiceSupport': { requireSupabase: () => client },
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

function edgeFixture({ role = 'owner', extraDevices = 0 } = {}) {
  const calls = []
  const usersRequested = []
  let maxConcurrent = 0
  let concurrent = 0
  const tables = {
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
      listUsers() { assert.fail('Access listing must never enumerate project Auth users') },
    },
  }
  let handler
  compileComponent(edgeSource, { 'jsr:@supabase/supabase-js@2': { createClient: () => client } }, {
    Deno: { env: { get: () => 'test-value' }, serve: callback => { handler = callback } },
    Response, console,
  })
  return {
    calls, usersRequested,
    get maxConcurrent() { return maxConcurrent },
    request(body = {}) {
      return handler(new Request('https://example.test', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ action: 'list', tenantId: 'tenant-a', ...body }) }))
    },
  }
}

test('edge scopes selected venue, includes owners and assigned managers, preserves full manager scopes and session status', async () => {
  const fixture = edgeFixture()
  const result = await fixture.request({ venueId: 'venue-a' })
  assert.equal(result.status, 200)
  const data = await result.json()
  assert.deepEqual(data.users.map(user => user.id), ['owner', 'manager-a'])
  assert.deepEqual(data.users[1].venueIds, ['venue-a', 'venue-b'])
  assert.deepEqual(data.deviceAccounts.map(account => account.deviceId), ['device-a'])
  assert.equal(data.deviceAccounts[0].hasActiveLogin, true)
  assert.deepEqual(fixture.usersRequested.sort(), ['cashier-a', 'manager-a', 'owner'])
  assert.deepEqual(fixture.calls.find(call => call.table === 'device_user_assignments').filters, { tenant_id: 'tenant-a', venue_id: 'venue-a' })
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

test('edge remains compatible with old clients without venueId and bounds Auth concurrency', async () => {
  const fixture = edgeFixture({ extraDevices: 18 })
  const result = await fixture.request()
  assert.equal(result.status, 200)
  const data = await result.json()
  assert.equal(data.deviceAccounts.length, 20)
  assert.equal(data.users.length, 3)
  assert.equal(fixture.usersRequested.length, 23)
  assert.ok(fixture.maxConcurrent > 1 && fixture.maxConcurrent <= 8)
})

function pageFixture(service) {
  const passthrough = ({ children }) => children
  return createCompiledHookRunner(pageSource, 'AccessManagementCrm', {
    'react/jsx-runtime': jsxRuntime,
    '../../../../components/ui/appDialogStore': {},
    '../../../../components/ui/Input': { Input: 'input' },
    '../../../../components/ui/Button': { Button: 'button' },
    '../../../../components/ui/Checkbox': { Checkbox: 'checkbox' },
    'lucide-react': Object.fromEntries(['Copy', 'LogOut', 'MapPin', 'MonitorSmartphone', 'Pencil', 'Plus', 'RefreshCw', 'Save', 'ShieldCheck', 'Trash2', 'X'].map(name => [name, passthrough])),
    sileo: { sileo: { success() {} } },
    '../../shared/components/CrmModal': { CrmModal: passthrough },
    '../../shared/components/CrmModalBusyContext': { useCrmModalBusy: () => false },
    '../../shared/components/CrmSelect': { CrmSelect: 'select' },
    '../../shared/components/EmptyList': { EmptyList: passthrough },
    '../../shared/components/Field': { Field: 'field' },
    '../../shared/formatCrmDateTime': {},
    '../services/accessService': service,
  })
}

test('device creation inherits the layout venue without a selector; obsolete refreshes cannot overwrite newer data', async () => {
  const requests = []
  const created = []
  const runner = pageFixture({
    loadCrmAccessData(ctx, venueId) { return new Promise(resolve => requests.push({ ctx, venueId, resolve })) },
    async createCrmDevice(...args) { created.push(args); return { email: 'new@example.test', password: 'ABCDEF' } },
  })
  const props = { disabled: false, tenantContext: context, selectedVenueId: 'venue-b', venues: [{ id: 'venue-a', isActive: true }, { id: 'venue-b', isActive: true }], runAction: action => action() }
  const render = () => nodes(runner.render(props))
  let tree = render()
  assert.equal(requests[0].venueId, 'venue-b')
  assert.equal(tree.some(node => node.props?.label === 'Local'), false)
  tree.find(node => node.type === 'input' && node.props.maxLength === 80).props.onChange({ target: { value: 'Caja nueva' } })
  tree = render()
  tree.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await flush()
  assert.deepEqual(created[0], [context, 'venue-b', 'Caja nueva', 'checkout'])
  requests[1].resolve({ devices: [{ id: 'new', name: 'Current', venueId: 'venue-b' }], users: [] })
  await flush()
  requests[0].resolve({ devices: [{ id: 'old', name: 'Obsolete', venueId: 'venue-b' }], users: [] })
  await flush()
  tree = render()
  assert.ok(tree.some(node => node.type === 'strong' && node.props.children === 'Current'))
  assert.ok(!tree.some(node => node.type === 'strong' && node.props.children === 'Obsolete'))
  assert.equal(requests.length, 2)
  runner.unmount()
})
