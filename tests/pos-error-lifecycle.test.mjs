import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const lifecycle = await readFile(new URL('../src/app/pos-error-lifecycle.ts', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8')
const domainErrors = await readFile(new URL('../src/app/useDomainErrors.ts', import.meta.url), 'utf8')

test('los errores puntuales del TPV desaparecen a los cinco segundos', () => {
  assert.match(lifecycle, /POS_TRANSIENT_ERROR_DURATION_MS = 5_000/)
  assert.match(page, /window\.setTimeout\(\(\) => clearDisplayedError\(null\), POS_TRANSIENT_ERROR_DURATION_MS\)/)
  assert.match(page, /return \(\) => window\.clearTimeout\(timer\)/)
  assert.match(domainErrors, /setErrorId\(\(current\) => current \+ 1\)/)
  assert.match(page, /displayedErrorId/)
})

test('los errores Cashlogy siguen fijos solo mientras el estado continúa activo', () => {
  assert.match(lifecycle, /cashlogyActiveStatuses\.has\(input\.transaction\.status\)/)
  assert.match(lifecycle, /input\.transaction\.status === 'unknown'/)
  assert.match(lifecycle, /input\.transaction\.status === 'needs_attention'/)
  const activeReturn = lifecycle.match(/return cashlogyActiveStatuses[\s\S]*?\n}/)?.[0] ?? ''
  assert.doesNotMatch(activeReturn, /cancelled/)
  assert.match(page, /if \(!displayedError \|\| activeCashlogyError\) return undefined/)
})

test('la tarjeta temporal muestra un temporizador circular a la izquierda del mensaje', () => {
  assert.match(page, /!activeCashlogyError \? <ErrorCountdownIndicator key=\{displayedErrorId\}/)
  assert.match(page, /attributeName="stroke-dashoffset"/)
  assert.match(page, /dur=\{`\$\{POS_TRANSIENT_ERROR_DURATION_MS\}ms`\}/)
  assert.doesNotMatch(page, /animate-spin/)
  assert.match(page, /<ErrorCountdownIndicator[\s\S]*<span>\{props\.error\}<\/span>/)
})
