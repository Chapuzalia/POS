export const MAX_INVENTORY_DECIMAL_PLACES = 6

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
  validateInventoryDecimalPlaces(decimalPlaces)
  const normalized = value.trim().replace(',', '.')
  if (!/^(?:\d+|\d*\.\d+)$/.test(normalized)) throw new Error('Indica una cantidad válida.')
  const quantity = Number(normalized)
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('La cantidad no puede ser negativa.')
  const scale = 10 ** decimalPlaces
  if (Math.abs(quantity * scale - Math.round(quantity * scale)) > 1e-7) {
    throw new Error(`Esta unidad admite como máximo ${decimalPlaces} decimales.`)
  }
  return Math.round(quantity * scale) / scale
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
) {
  if (
    !Number.isFinite(formatConsumptionQuantity)
    || !Number.isFinite(soldQuantity)
    || !Number.isFinite(contentQuantityPerStockUnit)
    || formatConsumptionQuantity <= 0
    || soldQuantity <= 0
    || contentQuantityPerStockUnit <= 0
  ) {
    throw new Error('Los datos de consumo deben ser mayores que cero.')
  }
  return Math.round((formatConsumptionQuantity * soldQuantity / contentQuantityPerStockUnit) * 1_000_000) / 1_000_000
}
