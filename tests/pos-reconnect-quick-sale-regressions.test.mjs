import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applyQuickSaleLinesUpdate } from '../src/features/quick-sale/services/lineUpdates.ts'
import {
  setQuickSaleTicketLineQuantity,
  setQuickSaleTicketLineUnitPrice,
} from '../src/features/quick-sale/services/ticketLineEdits.ts'

const root = new URL('../', import.meta.url)

function line(id, quantity = 1) {
  return {
    id,
    productId: id,
    productName: id,
    variantId: `${id}-variant`,
    variantName: 'Normal',
    basePriceCents: 100,
    componentDeltaCents: 0,
    modifierDeltaCents: 0,
    unitPriceCents: 100,
    quantity,
    modifiers: [],
    components: [],
    catalogSnapshot: {
      placementId: null,
      productType: 'standard',
      productId: id,
      productName: id,
      variantId: `${id}-variant`,
      variantName: 'Normal',
      basePriceCents: 100,
      vatRate: 21,
      categoryId: null,
      categoryName: '',
      catalogTabId: null,
      catalogTabName: '',
      saleFormatId: null,
      saleFormatName: 'Normal',
    },
  }
}

test('un reconnect mantiene cargada la configuracion y no reinicializa posView', async () => {
  const [realtime, appShell] = await Promise.all([
    readFile(new URL('src/features/restaurant/hooks/useRestaurantRealtime.ts', root), 'utf8'),
    readFile(new URL('src/app/AppShell.tsx', root), 'utf8'),
  ])

  assert.match(realtime, /loadedContextKeyRef\.current !== contextKey/)
  assert.match(realtime, /if \(isInitialLoad\) setConfigLoaded\(false\)/)
  assert.match(realtime, /source = isInitialLoad \? 'initial' : wasOfflineRef\.current \? 'reconnect' : 'refresh'/)
  assert.match(realtime, /if \(shouldInitializeView\) latestRef\.current\.setPosView\(\{ type: 'table_map'/)
  assert.match(realtime, /if \(shouldInitializeView \|\| tablesWereEnabled\) latestRef\.current\.setPosView\(\{ type: 'quick_sale' \}\)/)
  assert.doesNotMatch(realtime, /let initialized = false/)
  assert.match(appShell, /isOnline && !restaurant\.tablesConfigLoaded/)
})

test('las actualizaciones funcionales conservan taps consecutivos y persisten el ultimo estado', async () => {
  const hook = await readFile(new URL('src/features/quick-sale/hooks/useQuickSale.ts', root), 'utf8')
  assert.match(hook, /setLines\(\(previous\) => applyQuickSaleLinesUpdate/)
  assert.match(hook, /addQuickSaleTicketLine\(previous,/)
  assert.match(hook, /changeQuickSaleTicketLineQuantity\(previous,/)
  assert.match(hook, /previous\.filter\(\(line\) => line\.id !== lineId\)/)
  assert.doesNotMatch(hook, /addQuickSaleTicketLine\(lines,/)
  assert.doesNotMatch(hook, /changeQuickSaleTicketLineQuantity\(lines,/)

  const persisted = []
  const persist = (next) => persisted.push(next)
  let visible = []
  for (const id of ['A', 'B', 'C']) {
    visible = applyQuickSaleLinesUpdate(visible, (previous) => [...previous, line(id)], persist)
  }
  assert.deepEqual(visible.map((item) => item.id), ['A', 'B', 'C'])

  visible = [line('A')]
  for (let tap = 0; tap < 3; tap += 1) {
    visible = applyQuickSaleLinesUpdate(
      visible,
      (previous) => previous.map((item) => item.id === 'A' ? { ...item, quantity: item.quantity + 1 } : item),
      persist,
    )
  }
  assert.equal(visible[0].quantity, 4)
  assert.deepEqual(persisted.at(-1), visible)
})

test('el keypad actualiza cantidad y precio unitario sin mutar las demas lineas', () => {
  const original = [line('A', 2), line('B')]
  const withQuantity = setQuickSaleTicketLineQuantity(original, 'A', 7)
  const withPrice = setQuickSaleTicketLineUnitPrice(withQuantity, 'A', 650)

  assert.equal(withPrice[0].quantity, 7)
  assert.equal(withPrice[0].unitPriceCents, 650)
  assert.strictEqual(withPrice[1], original[1])
  assert.equal(original[0].quantity, 2)
  assert.equal(original[0].unitPriceCents, 100)
})

test('los breadcrumbs cubren conectividad, configuracion, montaje y restauracion', async () => {
  const sources = await Promise.all([
    'src/hooks/useOnlineStatus.ts',
    'src/features/restaurant/hooks/useRestaurantRealtime.ts',
    'src/app/PosPage.tsx',
    'src/features/session/hooks/useTenantSession.ts',
  ].map((path) => readFile(new URL(path, root), 'utf8')))
  const combined = sources.join('\n')
  for (const breadcrumb of [
    'connectivity.offline',
    'connectivity.online',
    'restaurant_config.initial_load_started',
    'restaurant_config.initial_load_finished',
    'restaurant_config.refresh_started',
    'restaurant_config.refresh_finished',
    'pos.mount',
    'pos.unmount',
    'session.restore_started',
    'session.restore_finished',
  ]) {
    assert.match(combined, new RegExp(breadcrumb.replace('.', '\\.')))
  }
})
