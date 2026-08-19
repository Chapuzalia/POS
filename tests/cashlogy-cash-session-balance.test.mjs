import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateCashlogyTotal } from '../src/features/local-printing/cashlogy/cashlogyCashBalanceValidation.ts'

test('el fondo Cashlogy suma reciclador y stacker y rechaza lecturas incoherentes', () => {
  const total = { recyclerTotalCents: 5000, stackerTotalCents: 12000, totalCents: 17000, queriedAt: '2026-08-19T10:00:00Z' }
  assert.equal(validateCashlogyTotal(total).totalCents, 17000)
  assert.throws(() => validateCashlogyTotal({ ...total, totalCents: 16999 }), /no coincide/)
  assert.throws(() => validateCashlogyTotal({ ...total, stackerTotalCents: -1 }), /no válido/)
})

test('la apertura consulta Cashlogy antes de persistir el fondo inicial', async () => {
  const hook = await readFile(new URL('../src/features/cash-registers/hooks/useCashSession.ts', import.meta.url), 'utf8')
  assert.match(hook, /cashlogyBalance = await loadActiveCashlogyCashBalance\(\)[\s\S]*effectiveOpeningFloatCents[\s\S]*openCashSessionLifecycle/)
})

test('el cierre vuelve a consultar Cashlogy y usa el total como contado y fondo final', async () => {
  const hook = await readFile(new URL('../src/features/cash-registers/hooks/useCashSession.ts', import.meta.url), 'utf8')
  assert.match(hook, /cashlogyBalance = await loadActiveCashlogyCashBalance\(\)[\s\S]*countedCashCents: cashlogyBalance\.totalCents[\s\S]*finalCashFundCents: cashlogyBalance\.totalCents/)
})

test('los formularios mantienen el fondo Cashlogy oculto y conservan el flujo manual sin máquina', async () => {
  const [gate, closing] = await Promise.all([
    readFile(new URL('../src/features/cash-registers/CashSessionGate.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/modals/CloseCashModal.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(gate, /Fondo automático desde Cashlogy/)
  assert.match(gate, /cashlogyConfigured[\s\S]*\? "Fondo gestionado por Cashlogy"/)
  assert.match(closing, /cashlogyCashCents !== null[\s\S]*\? "••••"[\s\S]*: value/)
  assert.match(closing, /cashlogyCashCents \?\? summary\.cashCents/)
})
