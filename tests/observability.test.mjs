import assert from 'node:assert/strict'
import test from 'node:test'
import * as Sentry from '@sentry/react'

import { sanitizeDiagnosticData } from '../src/lib/observabilityPrivacy.ts'

const captured = []
Sentry.init({
  dsn: 'https://public@example.invalid/1',
  defaultIntegrations: false,
  beforeSend(event, hint) { captured.push({ event, original: hint.originalException }); return null },
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
