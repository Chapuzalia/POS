import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compileComponent,
  createHookHarness,
  jsxRuntime,
  nodes,
} from './helpers/component-harness.mjs'

const source = await readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8')

function productDialogHarness() {
  const hooks = createHookHarness()
  const variant = { active: true, id: 'product-variant', name: 'Normal', priceCents: 800, productId: 'product', sortOrder: 0 }
  const mixerVariant = { active: true, id: 'mixer-variant', name: 'Normal', priceCents: 200, productId: 'mixer', sortOrder: 0 }
  const mixerOption = {
    defaultQuantity: 0,
    id: 'mixer-option',
    maxQuantity: 1,
    product: { id: 'mixer', image: null, name: 'Mixer' },
    sortOrder: 0,
    supplementCents: 150,
    variant: mixerVariant,
  }
  const sellable = {
    modifierGroups: [],
    product: { id: 'product', image: null, name: 'Product', type: 'standard' },
    selectionGroups: [{
      assignment: { displayName: null, maxSelection: 1, minSelection: 1 },
      group: { id: 'mixers', name: 'Mixers', type: 'mixer' },
      options: [mixerOption],
    }],
    variant,
  }
  const mixerSellable = { modifierGroups: [], product: mixerOption.product, selectionGroups: [], variant: mixerVariant }
  const catalog = { variants: [variant, mixerVariant] }
  const calls = { added: [], closed: 0 }
  const { ProductDialog } = compileComponent(source, {
    '../../features/catalog/domain/resolver': {
      resolveSellableProduct: (_catalog, productId) => productId === 'mixer' ? mixerSellable : sellable,
    },
    '../../features/catalog/services/saleLineBuilder': {
      calculateSaleLineTotals: () => ({ basePriceCents: 800, componentDeltaCents: 150, grossBeforeDiscountCents: 950, modifierDeltaCents: 0 }),
      canonicalizeProductLineSelection: (_catalog, _sellable, selection) => {
        if (selection.components.length !== 1) throw new Error('incomplete')
        return selection
      },
    },
    '../../lib/format': { formatMoney: String },
    '../../utils/cx': { cx: (...values) => values.filter(Boolean).join(' ') },
    '../pos/PosMixerCard': { PosMixerCard: 'mixer-card' },
    '../ui': { AppModal: 'app-modal', Button: 'button' },
    'lucide-react': { Minus: 'minus', Plus: 'plus', X: 'close' },
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
  })
  const props = {
    allowVariantSelection: false,
    catalog,
    isBusy: false,
    item: sellable,
    onAdd: (...args) => { calls.added.push(args); return true },
    onCancel: () => { calls.closed += 1 },
  }
  return { calls, hooks, ProductDialog, props }
}

test('aceptar un producto con mixer añade una sola línea y cierra el diálogo', () => {
  const harness = productDialogHarness()
  const dialog = harness.hooks.render(harness.ProductDialog, harness.props)
  const mixer = nodes(dialog).find((node) => node.type === 'mixer-card')
  const sourceElement = { id: 'mixer-button' }

  mixer.props.onSelect(sourceElement)
  mixer.props.onSelect(sourceElement)

  assert.equal(harness.calls.added.length, 1)
  assert.equal(harness.calls.closed, 1)
  assert.equal(harness.calls.added[0][1].mixerProductId, 'mixer')
  assert.equal(harness.calls.added[0][1].components.length, 1)
  assert.equal(harness.calls.added[0][3], sourceElement)
})
