import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasSelectableProductModifiers,
  shouldOpenProductSelectionDialog,
} from '../src/features/quick-sale/services/productSelectionDialog.ts'

const emptySelection = {
  modifiers: [],
  components: [],
  mixerProductId: null,
  mixer: null,
}

function itemWith({ modifierGroups = [], selectionGroups = [], type = 'standard' } = {}) {
  return {
    product: { type },
    modifierGroups,
    selectionGroups,
  }
}

function modifierGroup({ maximum = 1, minimum = 0, modifiers = [{}] } = {}) {
  return {
    assignment: { minSelection: minimum, maxSelection: maximum },
    modifiers,
  }
}

test('una única variante abre el selector cuando tiene modificadores opcionales 0–1', () => {
  const item = itemWith({ modifierGroups: [modifierGroup()] })

  assert.equal(hasSelectableProductModifiers(item), true)
  assert.equal(shouldOpenProductSelectionDialog({
    allowVariantSelection: false,
    defaultSelection: emptySelection,
    item,
    variantCount: 1,
  }), true)
})

test('una única variante sin opciones continúa añadiéndose directamente', () => {
  assert.equal(shouldOpenProductSelectionDialog({
    allowVariantSelection: false,
    defaultSelection: null,
    item: itemWith(),
    variantCount: 1,
  }), false)
})

test('un grupo opcional sin modificadores activos no fuerza un modal vacío', () => {
  const item = itemWith({ modifierGroups: [modifierGroup({ modifiers: [] })] })

  assert.equal(hasSelectableProductModifiers(item), false)
  assert.equal(shouldOpenProductSelectionDialog({
    allowVariantSelection: false,
    defaultSelection: emptySelection,
    item,
    variantCount: 1,
  }), false)
})

test('varias variantes siguen abriendo el selector aunque no haya modificadores', () => {
  assert.equal(shouldOpenProductSelectionDialog({
    allowVariantSelection: true,
    defaultSelection: null,
    item: itemWith(),
    variantCount: 2,
  }), true)
})

test('una selección obligatoria sin valor predeterminado sigue abriendo el selector', () => {
  const item = itemWith({ modifierGroups: [modifierGroup({ minimum: 1 })] })

  assert.equal(shouldOpenProductSelectionDialog({
    allowVariantSelection: false,
    defaultSelection: null,
    item,
    variantCount: 1,
  }), true)
})
