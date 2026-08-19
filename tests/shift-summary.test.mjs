import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { summarizeSales } from '../src/features/cash-registers/services/cashSummary.ts'

test('el resumen de turno separa efectivo y tarjeta sin incluir el fondo de caja', () => {
  const summary = summarizeSales(0, [
    { id: 'cash-1', cashSessionId: 'session', paymentMethod: 'cash', totalCents: 1250, createdAt: '2026-08-19T10:00:00Z' },
    { id: 'card-1', cashSessionId: 'session', paymentMethod: 'card', totalCents: 2300, createdAt: '2026-08-19T10:01:00Z' },
    { id: 'cash-2', cashSessionId: 'session', paymentMethod: 'cash', totalCents: 450, createdAt: '2026-08-19T10:02:00Z' },
    { id: 'invitation', cashSessionId: 'session', paymentMethod: 'invitation', totalCents: 900, createdAt: '2026-08-19T10:03:00Z' },
  ])

  assert.equal(summary.cashCents, 1700)
  assert.equal(summary.cardCents, 2300)
  assert.equal(summary.invitationCents, 900)
})

test('Resumen de turno aparece inmediatamente después de Cerrar caja', async () => {
  const header = await readFile(new URL('../src/components/layout/AppHeader.tsx', import.meta.url), 'utf8')
  assert.match(header, /id: 'close-cash'[\s\S]*id: 'shift-summary', label: 'Resumen de turno'/)
})

test('el modal muestra únicamente facturación y permite actualizar los datos confirmados', async () => {
  const [modal, cashSession] = await Promise.all([
    readFile(new URL('../src/components/modals/ShiftSummaryModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/cash-registers/hooks/useCashSession.ts', import.meta.url), 'utf8'),
  ])

  assert.match(modal, /summarizeSales\(0, sales\)/)
  assert.match(modal, /Efectivo facturado/)
  assert.match(modal, /Tarjeta facturada/)
  assert.match(modal, /No incluye el fondo inicial ni las entradas o salidas manuales/)
  assert.match(cashSession, /await syncPendingEvents\(\)[\s\S]*loadSalesLedgerFromSupabase/)
})
