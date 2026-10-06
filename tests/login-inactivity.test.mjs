import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { isCrmUser } from '../src/app/app-permissions.ts'

const loginActivity = readFileSync(
  new URL('../src/features/session/hooks/useLoginActivity.ts', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('../supabase/migrations/20260826120000_separate_login_activity_lease.sql', import.meta.url),
  'utf8',
)
const consolidatedDatabase = readFileSync(
  new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url),
  'utf8',
)

test('el limite de inactividad fuera del CRM sigue siendo de cuatro horas', () => {
  assert.match(loginActivity, /inactivityMs\s*=\s*4 \* 60 \* 60 \* 1000/)
  assert.doesNotMatch(loginActivity, /inactivityMs\s*=\s*30 \* 60 \* 1000/)
})

function activityHarness(role) {
  let now = 0
  let ownsLease = true
  const timers = new Map()
  const closed = []
  const window = new EventTarget()
  const document = new EventTarget()
  document.visibilityState = 'visible'
  let nextTimerId = 0
  window.setTimeout = (callback, delay) => {
    timers.set(++nextTimerId, { callback, dueAt: now + delay })
    return nextTimerId
  }
  window.clearTimeout = (id) => timers.delete(id)
  const exports = {}
  vm.runInNewContext(ts.transpileModule(loginActivity, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText, {
    exports, window, document, Date: { now: () => now },
    require: (id) => {
      if (id === 'react') return { useRef: (value) => ({ current: value }), useEffect: (callback) => callback() }
      if (id.endsWith('/app-permissions')) return { isCrmUser }
      if (id.endsWith('/observability.ts')) return { reportOperationError() {}, operationBreadcrumb() {} }
      if (id.endsWith('/loginLeaseService')) return {
        claimLoginLease: async () => ownsLease,
        checkLoginLease: async () => ownsLease,
        heartbeatLoginLease: async () => ownsLease,
      }
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  exports.useLoginActivity({ context: { role }, isOnline: true,
    onSessionClosed: async (message, blocked) => { closed.push({ message, blocked }) },
  })
  return { closed, document, loseLease: () => { ownsLease = false }, advance: (duration) => {
    now += duration
    for (const [id, timer] of timers) {
      if (timer.dueAt <= now) { timers.delete(id); timer.callback() }
    }
  } }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

for (const role of ['owner', 'manager', 'cashier', 'superadmin']) {
  test(`inactividad y perdida de acceso para ${role}`, async () => {
    const app = activityHarness(role)
    await flush()
    app.advance(5 * 60 * 60 * 1000)
    app.document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    if (!isCrmUser({ role })) {
      assert.equal(app.closed.length, 1)
      assert.equal(app.closed[0].blocked, false)
      return
    }
    assert.equal(app.closed.length, 0, 'CRM remains signed in beyond four hours')
    app.loseLease()
    app.document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    assert.equal(app.closed.length, 1, 'CRM still enforces lease ownership')
    assert.equal(app.closed[0].blocked, true)
  })
}

test('el heartbeat depende exclusivamente de actividad y se limita a uno cada 30 segundos', () => {
  assert.match(loginActivity, /heartbeatThrottleMs\s*=\s*30_000/)
  assert.doesNotMatch(loginActivity, /setInterval\s*\(/)
})

test('las comprobaciones no renuevan el lease y la actividad puede reclamar uno expirado', () => {
  assert.ok(loginActivity.includes('heartbeatLoginLease()'))
  assert.ok(loginActivity.includes('checkLoginLease()'))
  assert.ok(loginActivity.includes('claimLoginLease(false)'))
})

test('la concesion de actividad dura dos minutos sin cambiar la sesion de cuatro horas', () => {
  assert.match(migration, /alter column expires_at set default \(now\(\) \+ interval '2 minutes'\)/i)
  assert.ok(migration.includes('public.claim_user_login('))
  assert.ok(migration.includes('public.force_claim_user_login('))
  assert.ok(migration.includes('public.heartbeat_user_login('))
  assert.doesNotMatch(migration, /interval '4 hours'/i)
})

test('el esquema consolidado historico permanece sin modificar', () => {
  assert.doesNotMatch(consolidatedDatabase, /interval '30 minutes'/i)
  assert.doesNotMatch(consolidatedDatabase, /'00:30:00'::interval/i)
  assert.equal((consolidatedDatabase.match(/interval '4 hours'/g) ?? []).length, 3)
  assert.match(consolidatedDatabase, /'04:00:00'::interval/i)
})
