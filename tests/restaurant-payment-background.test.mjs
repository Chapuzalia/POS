import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const controller = await readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')
const paymentFlow = controller.match(/const completePayment = useCallback[\s\S]*?const requestCloseCash = useCallback/)?.[0] ?? ''
const completedPayment = paymentFlow.slice(paymentFlow.indexOf('finishCashlogyPayment'))
const foreground = completedPayment.slice(0, completedPayment.indexOf('const refreshMapTask'))
const background = completedPayment.slice(completedPayment.indexOf('const refreshMapTask'))

test('el cobro de mesa libera la interfaz antes de las sincronizaciones auxiliares', () => {
  assert.match(foreground, /releasedTableIds[\s\S]*realtime\.setMap[\s\S]*status: table\.nextReservation \? 'reserved' : 'free'/)
  assert.match(foreground, /draft\.replaceOrder\(nextOrder\)[\s\S]*setPendingPayment\(null\)[\s\S]*setPosView\(/)
  assert.doesNotMatch(foreground, /await cleanupVirtualRoomTable/)
  assert.doesNotMatch(foreground, /await fiscalizeTicketForPrint/)
  assert.doesNotMatch(foreground, /await refreshSales/)
  assert.doesNotMatch(foreground, /await realtime\.loadCurrentMap/)
})

test('mapa, pendientes, ventas, fiscalización e impresión continúan en segundo plano', () => {
  assert.match(background, /cleanupVirtualRoomTable\(saved, true\)/)
  assert.match(background, /realtime\.loadCurrentMap/)
  assert.match(background, /options\.syncPendingEvents\(\)/)
  assert.match(background, /refreshSales\(result\.saleId/)
  assert.match(background, /Promise\.all\(\[[\s\S]*fiscalizeTicketForPrint[\s\S]*loadTicketInvoice/)
  assert.match(background, /Promise\.allSettled\(\[refreshMapTask, refreshSalesTask, printTask\]\)/)
})

test('la consulta previa de pendientes solo bloquea antes de cobrar con Cashlogy', () => {
  assert.match(paymentFlow, /method === 'cash'[\s\S]*cashlogyConfigured[\s\S]*!forceWithPending/)
  assert.match(paymentFlow, /if \(requiresCashlogyPreflight\)[\s\S]*loadRestaurantOrderPendingUnits/)
  assert.match(paymentFlow, /const result = await closeRestaurantOrder[\s\S]*if \(result\.requiresConfirmation\)/)
})
