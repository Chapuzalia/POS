import { normalizeText } from './format.ts'

const DEFAULT_REVO_FORMAT = 'Unidad'
const DEFAULT_REVO_TAB = 'Productos'
const DEFAULT_REVO_CATEGORY = 'Otros'

export type RevoImportVariant = {
  formatName: string
  name: string
  priceCents: number
  sku: string | null
  sortOrder: number
  sourceFormat: string
  sourceFormatId: string
  sourceItemFormatId: string
}

export type RevoImportProduct = {
  active: boolean
  categoryName: string
  name: string
  sourceCategories: string[]
  sourceIds: string[]
  tabName: string
  variants: RevoImportVariant[]
  vatRate: number | null
  warnings: string[]
}

export type RevoImportParseResult = {
  products: RevoImportProduct[]
  skippedRows: number
  warnings: string[]
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeImportKey(value: string) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()
}

function displayName(value: string) {
  const cleaned = cleanText(value)
  return cleaned ? cleaned.charAt(0).toLocaleUpperCase('es') + cleaned.slice(1) : cleaned
}

function parseLocalizedNumber(value: string) {
  const compact = cleanText(value).replace(/\s/g, '').replace(/[^\d,.-]/g, '')
  if (!compact || !/^-?[\d.,]+$/.test(compact)) return null

  const commaIndex = compact.lastIndexOf(',')
  const dotIndex = compact.lastIndexOf('.')
  const decimalIndex = Math.max(commaIndex, dotIndex)
  let normalized = compact

  if (decimalIndex >= 0) {
    const integerPart = compact.slice(0, decimalIndex).replace(/[.,]/g, '')
    const decimalPart = compact.slice(decimalIndex + 1).replace(/[.,]/g, '')
    normalized = `${integerPart}.${decimalPart}`
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function parseEuroCents(value: string) {
  const parsed = parseLocalizedNumber(value)
  if (parsed === null || parsed < 0) return null
  const cents = Math.round(parsed * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

function parseVatRate(value: string) {
  if (!cleanText(value)) return null
  const parsed = parseLocalizedNumber(value)
  return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : null
}

function parseActive(value: string) {
  const normalized = normalizeImportKey(value)
  return !['0', 'false', 'no'].includes(normalized)
}

function parseCsvRows(csvText: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index]
    const nextChar = csvText[index + 1]

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"'
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === ';' && !inQuotes) {
      row.push(cell)
      cell = ''
      continue
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += char
  }

  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

export function parseRevoItemsCsv(csvText: string): RevoImportParseResult {
  const rows = parseCsvRows(csvText.replace(/^\uFEFF/, ''))
  if (!rows.length) throw new Error('El CSV de REVO est\u00e1 vac\u00edo.')

  const headers = rows[0].map((header) => cleanText(header).replace(/^\uFEFF/, ''))
  const headerIndex = new Map(headers.map((header, index) => [header, index]))
  const requiredHeaders = ['id', 'category.group.name', 'category.name', 'name', 'active', 'sellingFormat', 'price']
  const missingHeaders = requiredHeaders.filter((header) => !headerIndex.has(header))
  if (missingHeaders.length) {
    throw new Error(`El CSV de REVO no contiene las columnas requeridas: ${missingHeaders.join(', ')}.`)
  }

  const productsByKey = new Map<string, RevoImportProduct>()
  const warnings: string[] = []
  let skippedRows = 0

  function read(row: string[], header: string) {
    return cleanText(row[headerIndex.get(header) ?? -1] ?? '')
  }

  rows.slice(1).forEach((row, rowIndex) => {
    const csvRowNumber = rowIndex + 2
    const sourceId = read(row, 'id')
    const productName = read(row, 'name')
    const rawPrice = read(row, 'price')
    const priceCents = parseEuroCents(rawPrice)

    if (!productName || priceCents === null) {
      skippedRows += 1
      warnings.push(`Fila ${csvRowNumber} omitida: nombre o precio no v\u00e1lido.`)
      return
    }

    const sourceGroupName = read(row, 'category.group.name')
    const sourceCategoryName = read(row, 'category.name')
    const tabName = sourceGroupName || DEFAULT_REVO_TAB
    const categoryName = sourceCategoryName || DEFAULT_REVO_CATEGORY
    const sourceFormat = read(row, 'sellingFormat')
    const formatName = displayName(sourceFormat) || DEFAULT_REVO_FORMAT
    const sourceFormatId = read(row, 'sellingFormatId')
    const sourceFormatOrder = Number.parseInt(sourceFormatId, 10)
    const productKey = sourceId
      ? `id:${sourceId}`
      : `fallback:${normalizeImportKey(tabName)}:${normalizeImportKey(categoryName)}:${normalizeImportKey(productName)}`
    const sourceCategory = cleanText([sourceGroupName, sourceCategoryName].filter(Boolean).join(' / '))
    const parsedVatRate = parseVatRate(read(row, 'tax'))
    const rawTaxRate = read(row, 'tax')
    const current = productsByKey.get(productKey) ?? ({
      active: false,
      categoryName,
      name: productName,
      sourceCategories: [],
      sourceIds: [],
      tabName,
      variants: [],
      vatRate: parsedVatRate,
      warnings: [],
    } satisfies RevoImportProduct)

    if (normalizeImportKey(current.name) !== normalizeImportKey(productName)) {
      current.warnings.push(`Fila ${csvRowNumber}: el ID ${sourceId} aparece con otro nombre (${productName}).`)
    }
    if (normalizeImportKey(current.tabName) !== normalizeImportKey(tabName)
      || normalizeImportKey(current.categoryName) !== normalizeImportKey(categoryName)) {
      current.warnings.push(`Fila ${csvRowNumber}: el ID ${sourceId} aparece en otra categor\u00eda (${tabName} / ${categoryName}).`)
    }
    if (rawTaxRate && parsedVatRate === null) {
      current.warnings.push(`Fila ${csvRowNumber}: IVA no v\u00e1lido (${rawTaxRate}); se usar\u00e1 el predeterminado del local.`)
    } else if (current.vatRate !== null && parsedVatRate !== null && current.vatRate !== parsedVatRate) {
      current.warnings.push(`Fila ${csvRowNumber}: el IVA no coincide con las otras variantes; se conserva ${current.vatRate}%.`)
    } else if (current.vatRate === null) {
      current.vatRate = parsedVatRate
    }

    const variantKey = normalizeImportKey(formatName)
    const variant: RevoImportVariant = {
      formatName,
      name: formatName,
      priceCents,
      sku: read(row, 'barcode') || null,
      sortOrder: Number.isSafeInteger(sourceFormatOrder) && sourceFormatOrder >= 0 ? sourceFormatOrder : current.variants.length,
      sourceFormat,
      sourceFormatId,
      sourceItemFormatId: read(row, 'item_format_id'),
    }
    const existingVariantIndex = current.variants.findIndex((item) => normalizeImportKey(item.formatName) === variantKey)
    if (existingVariantIndex >= 0) {
      current.variants[existingVariantIndex] = variant
      current.warnings.push(`Fila ${csvRowNumber}: formato duplicado actualizado (${formatName}).`)
    } else {
      current.variants.push(variant)
    }

    current.active = current.active || parseActive(read(row, 'active'))
    current.sourceIds = [...new Set([...current.sourceIds, sourceId].filter(Boolean))]
    current.sourceCategories = [...new Set([...current.sourceCategories, sourceCategory].filter(Boolean))]
    productsByKey.set(productKey, current)
  })

  const products = [...productsByKey.values()]
    .map((product) => ({
      ...product,
      variants: [...product.variants].sort((left, right) => left.sortOrder - right.sortOrder || left.formatName.localeCompare(right.formatName, 'es')),
    }))
    .sort((left, right) => left.tabName.localeCompare(right.tabName, 'es')
      || left.categoryName.localeCompare(right.categoryName, 'es')
      || left.name.localeCompare(right.name, 'es'))

  return { products, skippedRows, warnings }
}
