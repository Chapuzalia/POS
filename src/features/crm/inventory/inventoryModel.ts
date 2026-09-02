export const MAX_INVENTORY_DECIMAL_PLACES = 6

export type InventoryCostSource = 'average' | 'last_purchase' | 'reference'

export function getEffectiveInventoryItemCost(item: {
  averageCost: number | null
  lastPurchaseCost: number | null
  referenceCost: number | null
}): { cost: number; source: InventoryCostSource } | null {
  if (item.averageCost !== null && Number.isFinite(item.averageCost) && item.averageCost >= 0) {
    return { cost: item.averageCost, source: 'average' }
  }
  if (item.lastPurchaseCost !== null && Number.isFinite(item.lastPurchaseCost) && item.lastPurchaseCost >= 0) {
    return { cost: item.lastPurchaseCost, source: 'last_purchase' }
  }
  if (item.referenceCost !== null && Number.isFinite(item.referenceCost) && item.referenceCost >= 0) {
    return { cost: item.referenceCost, source: 'reference' }
  }
  return null
}

export function validateInventoryName(value: string, entityLabel: string) {
  const name = value.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error(`Indica el nombre ${entityLabel}.`)
  if (name.length > 80) throw new Error(`El nombre ${entityLabel} no puede superar 80 caracteres.`)
  return name
}

export function validateInventoryUnitSymbol(value: string) {
  const symbol = value.trim().replace(/\s+/g, ' ')
  if (!symbol) throw new Error('Indica la abreviatura de la unidad.')
  if (symbol.length > 12) throw new Error('La abreviatura no puede superar 12 caracteres.')
  return symbol
}

export function validateInventoryDecimalPlaces(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INVENTORY_DECIMAL_PLACES) {
    throw new Error(`Los decimales deben estar entre 0 y ${MAX_INVENTORY_DECIMAL_PLACES}.`)
  }
  return value
}

export function parseInventoryQuantity(value: string, decimalPlaces: number) {
  return parseInventoryQuantityValue(value, decimalPlaces, false)
}

export function parseInventoryStockQuantity(value: string, decimalPlaces: number) {
  return parseInventoryQuantityValue(value, decimalPlaces, true)
}

function parseInventoryQuantityValue(value: string, decimalPlaces: number, allowNegative: boolean) {
  validateInventoryDecimalPlaces(decimalPlaces)
  const normalized = value.trim().replace(',', '.')
  const pattern = allowNegative ? /^-?(?:\d+|\d*\.\d+)$/ : /^(?:\d+|\d*\.\d+)$/
  if (!pattern.test(normalized)) throw new Error('Indica una cantidad válida.')
  const quantity = Number(normalized)
  if (!Number.isFinite(quantity) || (!allowNegative && quantity < 0)) throw new Error('La cantidad no puede ser negativa.')
  const scale = 10 ** decimalPlaces
  if (Math.abs(quantity * scale - Math.round(quantity * scale)) > 1e-7) {
    throw new Error(`Esta unidad admite como máximo ${decimalPlaces} decimales.`)
  }
  return Math.round(quantity * scale) / scale
}

export function addInventoryStockQuantity(currentQuantity: number, value: string, decimalPlaces: number) {
  if (!Number.isFinite(currentQuantity)) throw new Error('El stock actual no es válido.')
  const addition = parseInventoryQuantity(value, decimalPlaces)
  const scale = 10 ** decimalPlaces
  return Math.round((currentQuantity + addition) * scale) / scale
}

export function parsePositiveInventoryQuantity(value: string, decimalPlaces: number, label: string) {
  const quantity = parseInventoryQuantity(value, decimalPlaces)
  if (quantity <= 0) throw new Error(`${label} debe ser mayor que cero.`)
  return quantity
}

export function formatInventoryQuantity(value: number, decimalPlaces: number) {
  return new Intl.NumberFormat('es-ES', {
    maximumFractionDigits: decimalPlaces,
    minimumFractionDigits: 0,
  }).format(value)
}

export function inventoryQuantityStep(decimalPlaces: number) {
  validateInventoryDecimalPlaces(decimalPlaces)
  return decimalPlaces === 0 ? '1' : (1 / 10 ** decimalPlaces).toFixed(decimalPlaces)
}

export function calculateStockUnitConsumption(
  formatConsumptionQuantity: number,
  soldQuantity: number,
  contentQuantityPerStockUnit: number,
  contentQuantityPerFormatUnit = 1,
) {
  if (
    !Number.isFinite(formatConsumptionQuantity)
    || !Number.isFinite(soldQuantity)
    || !Number.isFinite(contentQuantityPerStockUnit)
    || !Number.isFinite(contentQuantityPerFormatUnit)
    || formatConsumptionQuantity <= 0
    || soldQuantity <= 0
    || contentQuantityPerStockUnit <= 0
    || contentQuantityPerFormatUnit <= 0
  ) {
    throw new Error('Los datos de consumo deben ser mayores que cero.')
  }
  return Math.round((
    formatConsumptionQuantity
    * contentQuantityPerFormatUnit
    * soldQuantity
    / contentQuantityPerStockUnit
  ) * 1_000_000) / 1_000_000
}
