import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8')

test('el selector de mixer cierra el modal inmediatamente al aceptar la línea', () => {
  const start = source.indexOf('function completeAdd(')
  const end = source.indexOf('function submitSelection', start)
  const completeAdd = start >= 0 && end > start ? source.slice(start, end) : null
  assert.ok(completeAdd)
  assert.match(completeAdd, /onCancel\(\)/)
  assert.doesNotMatch(completeAdd, /setTimeout|isClosing/)
})
