import assert from 'node:assert/strict'
import test from 'node:test'
import * as Sentry from '@sentry/react'
import { sileo } from 'sileo'
import { getReadableError } from '../src/utils/errors.ts'
import { UserFacingError } from '../src/utils/UserFacingError.ts'
import { reportOperationError, shouldReportError, safeOperationContext } from '../src/lib/observability.ts'
import { sanitizeDiagnosticData } from '../src/lib/observabilityPrivacy.ts'
import { notifyOperationalError } from '../src/utils/notifications.ts'
import { PrintAgentError } from '../src/features/local-printing/api/PrintAgentError.ts'
import { CashlogyError, toCashlogyError } from '../src/features/local-printing/cashlogy/cashlogyError.ts'

const captured = []
Sentry.init({
  dsn: 'https://public@example.invalid/1',
  defaultIntegrations: false,
  beforeSend(event, hint) { captured.push({ event, original: hint.originalException }); return null },
})

test('UI hides SQL details and sends the original error with operation context', async () => {
  const original = Object.assign(new Error('duplicate key violates unique constraint: private SQL'), { code: '23505' })
  const message = getReadableError(original, { operation: 'sale.persist.test', saleId: 'sale-123', cashSessionId: 'cash-1', step: 'persist' }, 'No se ha podido guardar la venta.')
  assert.equal(message, 'No se ha podido guardar la venta.')
  await Sentry.flush(1000)
  const incident = captured.find((item) => item.original === original)
  assert.ok(incident)
  assert.equal(incident.event.contexts.operation.saleId, 'sale-123')
  assert.equal(incident.event.contexts.operation.cashSessionId, 'cash-1')
  assert.equal(incident.event.tags.errorCode, '23505')
})

test('business validations and invalid credentials do not create incidents', async () => {
  const before = captured.length
  assert.equal(getReadableError(new UserFacingError('Selecciona una caja.')), 'Selecciona una caja.')
  assert.equal(getReadableError({ code: 'invalid_credentials', message: 'Invalid login credentials' }), 'El usuario o la contraseña no son correctos.')
  assert.equal(shouldReportError(new CashlogyError({ code: 'CASHLOGY_OPERATION_CANCELLED' }), { operation: 'cashlogy' }), false)
  await Sentry.flush(1000)
  assert.equal(captured.length, before)
})

test('expected offline is quiet but uncertain money and local persistence are captured', () => {
  const network = new TypeError('Failed to fetch')
  assert.equal(shouldReportError(network, { operation: 'offline.sync', recoverable: true, online: false }), false)
  assert.equal(shouldReportError(new Error('QuotaExceededError'), { operation: 'offline.storage', online: false }), true)
  assert.equal(shouldReportError(new CashlogyError({ code: 'CASHLOGY_STATUS_UNKNOWN' }), { operation: 'cashlogy', online: false }), true)
  assert.equal(shouldReportError({ code: '23514' }, { operation: 'offline.sync', recoverable: true }), true)
})

test('repeated sync rejection is deduplicated without hiding a different sale', async () => {
  const context = { operation: 'sync.dedupe.test', operationId: 'event-1', saleId: 'sale-1' }
  const first = new Error('Rejected')
  const before = captured.length
  reportOperationError(first, context)
  reportOperationError(first, { ...context, operation: 'outer.handler' })
  reportOperationError(new Error('Rejected'), context)
  reportOperationError(new Error('Rejected'), { ...context, saleId: 'sale-2', operationId: 'event-2' })
  await Sentry.flush(1000)
  assert.equal(captured.length - before, 2)
})

test('hardware mapping preserves cause and hides remote technical messages', () => {
  const original = new Error('ECONNREFUSED secret backend message')
  const print = new PrintAgentError({ code: 'PRINT_FAILED', message: original.message, cause: original })
  assert.equal(print.message, 'No se ha podido imprimir el ticket.')
  assert.equal(print.cause, original)
  const cashlogy = toCashlogyError(print)
  assert.equal(cashlogy.cause, print)
  assert.ok(!cashlogy.message.includes('ECONNREFUSED'))
})

test('operation context and telemetry exclude payloads, credentials and personal data', () => {
  assert.deepEqual(safeOperationContext({ operation: 'sale.persist', saleId: 'sale-1', online: false, password: 'secret', payload: { card: '1234' } }), { operation: 'sale.persist', saleId: 'sale-1', online: false })
  const sanitized = JSON.stringify(sanitizeDiagnosticData({
    message: 'Key (email)=(person@example.org) already exists; Bearer secret-token; https://host/path?token=private',
    contexts: { operation: { saleId: 'sale-1' }, details: { password: 'secret' } },
    user: { email: 'person@example.org' },
  }))
  for (const secret of ['person@example.org', 'secret-token', '?token=', 'password']) assert.ok(!sanitized.includes(secret))
  assert.ok(sanitized.includes('sale-1'))
})

test('operational notifications use Sileo and suppress repeated state', () => {
  const original = sileo.error
  const notices = []
  sileo.error = (options) => { notices.push(options); return 'test-toast' }
  try {
    notifyOperationalError('No se ha podido completar el cobro.')
    notifyOperationalError('No se ha podido completar el cobro.')
    assert.deepEqual(notices, [{ title: 'No se ha podido completar el cobro.' }])
  } finally { sileo.error = original }
})

test('Sentry production hooks sanitize raw Supabase exceptions and request data', async () => {
  const { readFile } = await import('node:fs/promises')
  const { default: ts } = await import('typescript')
  const { default: vm } = await import('node:vm')
  let config
  const source = (await readFile(new URL('../src/sentry.ts', import.meta.url), 'utf8')).replaceAll('import.meta.env', '__env')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
  vm.runInNewContext(compiled, {
    exports: {}, __env: {}, URL, Error,
    window: { location: { origin: 'https://pos.example' } },
    require(id) {
      if (id.includes('observabilityPrivacy')) return { sanitizeDiagnosticData }
      return { init(options) { config = options }, browserTracingIntegration() {}, replayIntegration() {} }
    },
  })
  const event = config.beforeSend({
    exception: { values: [{ value: 'Object captured as exception with keys: message', stacktrace: { frames: [{ filename: 'app.ts', lineno: 5 }] } }] },
    extra: { __serialized__: { payload: 'sensitive' } },
    request: { url: 'https://user:pass@pos.example/api?token=secret', data: 'private body', cookies: { session: 'secret' }, headers: { Authorization: 'Bearer secret', apikey: 'private' } },
  }, { originalException: { message: 'duplicate key violates constraint; Key (email)=(person@example.org)' } })
  assert.match(event.exception.values[0].value, /duplicate key violates constraint/)
  assert.equal(event.exception.values[0].stacktrace.frames[0].lineno, 5)
  assert.equal(event.request.url, 'https://pos.example/api')
  assert.equal(event.extra, undefined)
  const json = JSON.stringify(event)
  for (const sensitive of ['person@example.org', 'secret', 'private', 'pass@']) assert.ok(!json.includes(sensitive))
  assert.equal(config.beforeBreadcrumb({ category: 'console', message: 'password leaked' }), null)
})
