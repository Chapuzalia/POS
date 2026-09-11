import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBuildEnvironment } from '../build/validateBuildEnvironment.ts'

test('impide publicar una clave Supabase o DSN censurados por Vercel sin exponer valores', () => {
  for (const key of ['VITE_SUPABASE_ANON_KEY', 'VITE_SENTRY_DSN']) {
    assert.throws(() => validateBuildEnvironment({ [key]: ' [SENSITIVE] ', VITE_OTHER: 'private-value' }), (error) => {
      assert.ok(error.message.includes(key))
      assert.ok(!error.message.includes('private-value'))
      return true
    })
  }
})

test('acepta valores disponibles y compilaciones locales sin configuración de producción', () => {
  assert.doesNotThrow(() => validateBuildEnvironment({}))
  assert.doesNotThrow(() => validateBuildEnvironment({ VITE_SUPABASE_ANON_KEY: 'available', VITE_SENTRY_DSN: '' }))
})
