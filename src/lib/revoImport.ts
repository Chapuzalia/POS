import { normalizeText } from './format'
type RevoCategoryFamily = 'alcohol' | 'mixer' | 'beer' | 'beer_bottle' | 'soft_bottle' | 'cocktail' | 'other'
type RevoSellingFormat = 'cubata' | 'copa' | 'shot' | 'beer_bottle' | 'soft_bottle' | 'cocktail'

export type RevoImportVariant = {
  name: string
  priceCents: number
  saleFormat: RevoSellingFormat
  sortOrder: number
  sourceFormat: string
}

export type RevoImportProduct = {
  active: boolean
  categoryName: string
  name: string
  sourceCategories: string[]
  sourceIds: string[]
  variants: RevoImportVariant[]
  warnings: string[]
}

export type RevoImportParseResult = {
  products: RevoImportProduct[]
  skippedRows: number
  warnings: string[]
}

type RevoCategoryMapping = {
  categoryKind: RevoCategoryFamily
  categoryName: string
}

const saleFormatOrder: RevoSellingFormat[] = ['cubata', 'copa', 'shot', 'beer_bottle', 'soft_bottle', 'cocktail']

const variantNames: Record<RevoSellingFormat, string> = {
  beer_bottle: 'Botellin',
  cocktail: 'Coctel',
  copa: 'Copa',
  cubata: 'Cubata',
  shot: 'Chupito',
  soft_bottle: 'Botellin',
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeImportKey(value: string) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()
}

function titleCase(value: string) {
  return cleanText(value)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function parseEuroCents(value: string) {
  const normalized = value
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
  const parsed = Number.parseFloat(normalized)

  if (!Number.isFinite(parsed)) {
    return 0
  }

  return Math.max(0, Math.round(parsed * 100))
}

function parseActive(value: string) {
  return cleanText(value) !== '0'
}

function getVariantName(saleFormat: RevoSellingFormat, sourceFormat: string) {
  if (normalizeImportKey(sourceFormat).includes('ampolla')) {
    return 'Botella'
  }

  return variantNames[saleFormat]
}

function getCategoryMapping(categoryGroupName: string, categoryName: string): RevoCategoryMapping {
  const sourceName = cleanText(categoryName || categoryGroupName || 'Otros')
  const categoryKey = normalizeImportKey(categoryName)
  const groupKey = normalizeImportKey(categoryGroupName)
  const focusedKey = categoryKey || groupKey
  const key = `${categoryKey} ${groupKey}`.trim()

  if (focusedKey.includes('vi ') || focusedKey.includes('vins') || focusedKey.includes('vino') || focusedKey.includes('cava')) {
    return { categoryKind: 'alcohol', categoryName: 'Vinos y Cavas' }
  }

  if (focusedKey.includes('ginebra') || focusedKey === 'gin') {
    return { categoryKind: 'alcohol', categoryName: 'Ginebra' }
  }

  if (focusedKey.includes('ron')) {
    return { categoryKind: 'alcohol', categoryName: 'Ron' }
  }

  if (focusedKey.includes('whisky') || focusedKey.includes('wisky')) {
    return { categoryKind: 'alcohol', categoryName: 'Whisky' }
  }

  if (focusedKey.includes('vodka')) {
    return { categoryKind: 'alcohol', categoryName: 'Vodka' }
  }

  if (focusedKey.includes('tequila')) {
    return { categoryKind: 'alcohol', categoryName: 'Tequila' }
  }

  if (focusedKey.includes('xupit') || focusedKey.includes('xarrup') || focusedKey.includes('chupit')) {
    return { categoryKind: 'alcohol', categoryName: 'Chupitos' }
  }

  if (focusedKey.includes('refresc') || focusedKey.includes('suc') || focusedKey.includes('refresco')) {
    return { categoryKind: 'mixer', categoryName: 'Mixers y refrescos' }
  }

  if (focusedKey.includes('cerves') || focusedKey.includes('cervez')) {
    return { categoryKind: 'beer_bottle', categoryName: 'Cervezas' }
  }

  if (focusedKey.includes('coct') || focusedKey.includes('cock') || focusedKey.includes('ctel') || focusedKey.includes('mojito')) {
    return { categoryKind: 'cocktail', categoryName: 'Cocteles' }
  }

  if (focusedKey.includes('licor')) {
    return { categoryKind: 'alcohol', categoryName: 'Licores' }
  }

  if (key.includes('vi ') || key.includes('vins') || key.includes('vino') || key.includes('cava')) {
    return { categoryKind: 'alcohol', categoryName: 'Vinos y Cavas' }
  }

  if (key.includes('refresc') || key.includes('suc') || key.includes('refresco')) {
    return { categoryKind: 'mixer', categoryName: 'Mixers y refrescos' }
  }

  if (key.includes('cerves') || key.includes('cervez')) {
    return { categoryKind: 'beer_bottle', categoryName: 'Cervezas' }
  }

  if (key.includes('coct') || key.includes('cock') || key.includes('ctel') || key.includes('mojito')) {
    return { categoryKind: 'cocktail', categoryName: 'Cocteles' }
  }

  if (key.includes('altre') || key.includes('otro')) {
    return { categoryKind: 'other', categoryName: 'Otros' }
  }

  return { categoryKind: 'other', categoryName: titleCase(sourceName) || 'Otros' }
}

function getDefaultRevoSellingFormat(categoryKind: RevoCategoryFamily, categoryName: string): RevoSellingFormat {
  if (categoryKind === 'mixer' || categoryKind === 'soft_bottle') {
    return 'soft_bottle'
  }
  if (categoryKind === 'beer_bottle' || categoryKind === 'beer') {
    return 'beer_bottle'
  }
  if (categoryKind === 'cocktail') {
    return 'cocktail'
  }
  if (normalizeImportKey(categoryName).includes('chupit')) {
    return 'shot'
  }

  return categoryKind === 'alcohol' ? 'copa' : 'soft_bottle'
}

function getRevoSellingFormat(
  sourceFormat: string,
  categoryKind: RevoCategoryFamily,
  categoryName: string,
): { saleFormat: RevoSellingFormat | null; warning?: string } {
  const formatKey = normalizeImportKey(sourceFormat)

  if (!formatKey) {
    return { saleFormat: getDefaultRevoSellingFormat(categoryKind, categoryName) }
  }

  if (formatKey.includes('cubata')) {
    return { saleFormat: 'cubata' }
  }
  if (formatKey.includes('copa')) {
    return { saleFormat: 'copa' }
  }
  if (formatKey.includes('xupit') || formatKey.includes('xarrup') || formatKey.includes('chupit') || formatKey.includes('shot')) {
    return { saleFormat: 'shot' }
  }
  if (formatKey.includes('coct') || formatKey.includes('cock')) {
    return { saleFormat: 'cocktail' }
  }
  if (formatKey.includes('botell')) {
    return { saleFormat: categoryKind === 'beer_bottle' || categoryKind === 'beer' ? 'beer_bottle' : 'soft_bottle' }
  }
  if (formatKey.includes('ampolla')) {
    const saleFormat = categoryKind === 'beer_bottle' || categoryKind === 'beer' ? 'beer_bottle' : 'soft_bottle'
    return {
      saleFormat,
      warning: saleFormat === 'soft_bottle' ? 'Formato Ampolla importado como Botella por falta de formato botella.' : undefined,
    }
  }

  return {
    saleFormat: null,
    warning: `Formato no soportado: ${sourceFormat}`,
  }
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
      if (char === '\r' && nextChar === '\n') {
        index += 1
      }
      row.push(cell)
      if (row.some((value) => value.trim())) {
        rows.push(row)
      }
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  row.push(cell)
  if (row.some((value) => value.trim())) {
    rows.push(row)
  }

  return rows
}

export function parseRevoItemsCsv(csvText: string): RevoImportParseResult {
  const rows = parseCsvRows(csvText.replace(/^\uFEFF/, ''))
  const headers = rows[0]?.map((header) => cleanText(header).replace(/^\uFEFF/, '')) ?? []
  const headerIndex = new Map(headers.map((header, index) => [header, index]))
  const productsByKey = new Map<string, RevoImportProduct>()
  const warnings: string[] = []
  let skippedRows = 0

  function read(row: string[], header: string) {
    return cleanText(row[headerIndex.get(header) ?? -1] ?? '')
  }

  rows.slice(1).forEach((row, rowIndex) => {
    const sourceId = read(row, 'id')
    const productName = read(row, 'name')
    const price = read(row, 'price')

    if (!productName || !price) {
      skippedRows += 1
      return
    }

    const categoryGroupName = read(row, 'category.group.name')
    const categoryName = read(row, 'category.name')
    const categoryMapping = getCategoryMapping(categoryGroupName, categoryName)
    const sourceFormat = read(row, 'sellingFormat')
    const formatResult = getRevoSellingFormat(sourceFormat, categoryMapping.categoryKind, categoryMapping.categoryName)

    if (!formatResult.saleFormat) {
      skippedRows += 1
      warnings.push(`Fila ${rowIndex + 2} omitida (${productName}): ${formatResult.warning}`)
      return
    }

    const productKey = `${normalizeImportKey(categoryMapping.categoryName)}::${normalizeImportKey(productName)}`
    const variantName = getVariantName(formatResult.saleFormat, sourceFormat)
    const variantKey = normalizeImportKey(variantName)
    const sourceCategory = cleanText([categoryGroupName, categoryName].filter(Boolean).join(' / '))
    const rowWarning = formatResult.warning ? [`Fila ${rowIndex + 2}: ${formatResult.warning}`] : []
    const current =
      productsByKey.get(productKey) ??
      ({
        active: false,
        categoryName: categoryMapping.categoryName,
        name: productName,
        sourceCategories: [],
        sourceIds: [],
        variants: [],
        warnings: [],
      } satisfies RevoImportProduct)

    const existingVariantIndex = current.variants.findIndex((variant) => normalizeImportKey(variant.name) === variantKey)
    const variant: RevoImportVariant = {
      name: variantName,
      priceCents: parseEuroCents(price),
      saleFormat: formatResult.saleFormat,
      sortOrder: saleFormatOrder.indexOf(formatResult.saleFormat) + 1,
      sourceFormat: sourceFormat || variantName,
    }

    if (existingVariantIndex >= 0) {
      current.variants[existingVariantIndex] = variant
      current.warnings.push(`Formato duplicado actualizado: ${variantName}`)
    } else {
      current.variants.push(variant)
    }

    current.active = current.active || parseActive(read(row, 'active'))
    current.sourceIds = [...new Set([...current.sourceIds, sourceId].filter(Boolean))]
    current.sourceCategories = [...new Set([...current.sourceCategories, sourceCategory].filter(Boolean))]
    current.warnings = [...current.warnings, ...rowWarning]
    productsByKey.set(productKey, current)
  })

  const products = [...productsByKey.values()]
    .filter((product) => {
      if (!product.variants.length) {
        skippedRows += 1
        warnings.push(`Producto omitido sin formatos validos: ${product.name}`)
        return false
      }
      return true
    })
    .map((product) => ({
      ...product,
      variants: [...product.variants].sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name))

  return {
    products,
    skippedRows,
    warnings,
  }
}
