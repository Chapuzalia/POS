import { z } from "zod";

const nullableText = z.string().trim().max(500).nullable()
const nullableMoney = z.number().finite().nonnegative().nullable()
const polygonSchema = z.array(z.number().finite()).min(4)

export const ocrWordSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  polygon: polygonSchema.optional(),
}).strict()

export const ocrBlockSchema = z.object({
  type: z.string(),
  text: z.string(),
  polygon: polygonSchema,
  confidence: z.number().min(0).max(1).optional(),
  tableId: z.string().optional(),
  imageId: z.string().optional(),
}).strict()

export const ocrCellSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  columnIndex: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().default(1),
  columnSpan: z.number().int().positive().default(1),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  polygon: polygonSchema.optional(),
}).strict()

export const ocrTableSchema = z.object({
  rowCount: z.number().int().positive(),
  columnCount: z.number().int().positive(),
  cells: z.array(ocrCellSchema),
  polygon: polygonSchema.optional(),
}).strict()

export const ocrPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.string(),
  text: z.string(),
  words: z.array(ocrWordSchema),
  blocks: z.array(ocrBlockSchema).optional(),
  tables: z.array(ocrTableSchema),
  confidence: z.number().min(0).max(1),
}).strict()

export const ocrDocumentSchema = z.object({
  pages: z.array(ocrPageSchema).min(1),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  provider: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict()

export type OcrDocument = z.infer<typeof ocrDocumentSchema>
export type OcrTable = z.infer<typeof ocrTableSchema>

const parserFieldSchema = z.enum([
  'supplierReference',
  'description',
  'barcode',
  'quantity',
  'purchaseUnit',
  'unitPrice',
  'discountAmount',
  'lineTotal',
  'taxRate',
])

const lineGroupSchema = z.object({
  endAliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  discountAliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  chargeAliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  netTotalFromEndRow: z.boolean().default(false),
  maxContinuationRows: z.number().int().min(1).max(20).default(6),
}).strict().superRefine((rule, context) => {
  if (rule.endAliases.length + rule.discountAliases.length + rule.chargeAliases.length === 0) {
    context.addIssue({ code: 'custom', message: 'PROFILE_LINE_GROUP_ALIASES_MISSING' })
  }
  if (rule.netTotalFromEndRow && rule.endAliases.length === 0) {
    context.addIssue({ code: 'custom', message: 'PROFILE_LINE_GROUP_END_ALIAS_MISSING', path: ['endAliases'] })
  }
})

const supplierProfileRulesBaseSchema = z.object({
  version: z.literal(1),
  requiredTexts: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  optionalTexts: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  tableStartText: z.string().trim().min(1).max(120).nullable().default(null),
  tableEndText: z.string().trim().min(1).max(120).nullable().default(null),
  decimalSeparator: z.enum([',', '.']),
  thousandsSeparator: z.enum([',', '.', ' ', 'none']).default('none'),
  documentNumberLabel: z.string().trim().max(80).nullable().default(null),
  documentDateLabel: z.string().trim().max(80).nullable().default(null),
  lineGroup: lineGroupSchema.nullable().optional().default(null),
  columns: z.array(z.object({
    field: parserFieldSchema,
    headerAliases: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    required: z.boolean().default(false),
  }).strict()).min(3).max(16),
  normalizations: z.array(z.object({
    field: z.enum(['supplierReference', 'description', 'barcode', 'purchaseUnit']),
    operation: z.enum(['trim', 'collapse_spaces', 'uppercase', 'lowercase']),
  }).strict()).max(20).default([]),
}).strict()

export const supplierProfileRulesSchema = supplierProfileRulesBaseSchema.superRefine((rules, context) => {
  for (const field of parserFieldSchema.options) {
    const columns = rules.columns.filter((column) => column.field === field)
    if (columns.length > 1) {
      context.addIssue({ code: 'custom', message: `PROFILE_DUPLICATE_COLUMN:${field}`, path: ['columns'] })
    }
  }
  for (const field of ['description', 'quantity'] as const) {
    const column = rules.columns.find((candidate) => candidate.field === field)
    if (!column?.required) {
      context.addIssue({ code: 'custom', message: `PROFILE_REQUIRED_COLUMN_MISSING:${field}`, path: ['columns'] })
    }
  }
})

export type SupplierProfileRules = z.infer<typeof supplierProfileRulesSchema>

export const extractedLineSchema = z.object({
  supplierReference: nullableText,
  description: z.string().trim().min(1).max(500),
  barcode: nullableText,
  quantity: z.number().finite().positive(),
  purchaseUnit: nullableText,
  unitPrice: nullableMoney,
  discountAmount: z.number().finite().nonnegative().default(0),
  chargesAmount: z.number().finite().nonnegative().default(0),
  grossCost: nullableMoney,
  netCost: nullableMoney,
  lineTotal: nullableMoney,
  taxRate: nullableMoney,
  packageExpression: nullableText,
  confidence: z.number().min(0).max(1),
}).strict()

export const supplierDocumentExtractionSchema = z.object({
  document: z.object({
    type: z.enum(['invoice', 'delivery_note']),
    number: nullableText,
    date: nullableText,
    total: nullableMoney,
  }).strict(),
  supplier: z.object({
    name: z.string().trim().min(1).max(160),
    taxId: nullableText,
  }).strict(),
  lines: z.array(extractedLineSchema).min(1).max(500),
  proposedProfile: supplierProfileRulesBaseSchema.nullable(),
  confidence: z.number().min(0).max(1),
}).strict()

export type SupplierDocumentExtraction = z.infer<typeof supplierDocumentExtractionSchema>
export type ExtractedLine = z.infer<typeof extractedLineSchema>

export const supplierProfileRulesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version', 'requiredTexts', 'optionalTexts', 'tableStartText', 'tableEndText',
    'decimalSeparator', 'thousandsSeparator', 'documentNumberLabel',
    'documentDateLabel', 'lineGroup', 'columns', 'normalizations',
  ],
  properties: {
    version: { type: 'number', enum: [1] },
    requiredTexts: { type: 'array', minItems: 1, items: { type: 'string' } },
    optionalTexts: { type: 'array', items: { type: 'string' } },
    tableStartText: { type: ['string', 'null'] },
    tableEndText: { type: ['string', 'null'] },
    decimalSeparator: { type: 'string', enum: [',', '.'] },
    thousandsSeparator: { type: 'string', enum: [',', '.', ' ', 'none'] },
    documentNumberLabel: { type: ['string', 'null'] },
    documentDateLabel: { type: ['string', 'null'] },
    lineGroup: {
      anyOf: [{
        type: 'object',
        additionalProperties: false,
        required: ['endAliases', 'discountAliases', 'chargeAliases', 'netTotalFromEndRow', 'maxContinuationRows'],
        properties: {
          endAliases: { type: 'array', items: { type: 'string' } },
          discountAliases: { type: 'array', items: { type: 'string' } },
          chargeAliases: { type: 'array', items: { type: 'string' } },
          netTotalFromEndRow: { type: 'boolean' },
          maxContinuationRows: { type: 'number', minimum: 1, maximum: 20 },
        },
      }, { type: 'null' }],
    },
    columns: {
      type: 'array', minItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        required: ['field', 'headerAliases', 'required'],
        properties: {
          field: { type: 'string', enum: parserFieldSchema.options },
          headerAliases: { type: 'array', minItems: 1, items: { type: 'string' } },
          required: { type: 'boolean' },
        },
      },
    },
    normalizations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['field', 'operation'],
        properties: {
          field: { type: 'string', enum: ['supplierReference', 'description', 'barcode', 'purchaseUnit'] },
          operation: { type: 'string', enum: ['trim', 'collapse_spaces', 'uppercase', 'lowercase'] },
        },
      },
    },
  },
} as const

export const supplierDocumentExtractionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['document', 'supplier', 'lines', 'proposedProfile', 'confidence'],
  properties: {
    document: {
      type: 'object', additionalProperties: false,
      required: ['type', 'number', 'date', 'total'],
      properties: {
        type: { type: 'string', enum: ['invoice', 'delivery_note'] },
        number: { type: ['string', 'null'] },
        date: { type: ['string', 'null'] },
        total: { type: ['number', 'null'], minimum: 0 },
      },
    },
    supplier: {
      type: 'object', additionalProperties: false,
      required: ['name', 'taxId'],
      properties: { name: { type: 'string' }, taxId: { type: ['string', 'null'] } },
    },
    lines: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'supplierReference', 'description', 'barcode', 'quantity', 'purchaseUnit',
          'unitPrice', 'discountAmount', 'chargesAmount', 'grossCost', 'netCost', 'lineTotal',
          'taxRate', 'packageExpression', 'confidence',
        ],
        properties: {
          supplierReference: { type: ['string', 'null'] },
          description: { type: 'string' },
          barcode: { type: ['string', 'null'] },
          quantity: { type: 'number', exclusiveMinimum: 0 },
          purchaseUnit: { type: ['string', 'null'] },
          unitPrice: { type: ['number', 'null'], minimum: 0 },
          discountAmount: { type: 'number', minimum: 0 },
          chargesAmount: { type: 'number', minimum: 0 },
          grossCost: { type: ['number', 'null'], minimum: 0 },
          netCost: { type: ['number', 'null'], minimum: 0 },
          lineTotal: { type: ['number', 'null'], minimum: 0 },
          taxRate: { type: ['number', 'null'], minimum: 0 },
          packageExpression: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    proposedProfile: { anyOf: [supplierProfileRulesJsonSchema, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

const accentPattern = /[\u0300-\u036f]/g
const nonWordPattern = /[^a-z0-9]+/g
const spacesPattern = /\s+/g
const packagingPattern = /(?:(\d+(?:[.,]\d+)?)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml|unidades?|uds?|piezas?|botellas?|latas?)\b/i

export function normalizeDocumentText(value: string) {
  return value.normalize('NFD').replace(accentPattern, '').toLowerCase().replace(nonWordPattern, ' ').replace(spacesPattern, ' ').trim()
}

export function normalizeAlias(value: string) {
  return normalizeDocumentText(value)
}

const supplierLegalFormTokens = new Set([
  'sa', 'sau', 'sl', 'slu', 'slne', 'sc', 'scp', 'scoop', 'sociedad', 'anonima',
  'limitada', 'unipersonal', 'cooperativa',
])

export function normalizeSupplierTaxId(value: string | null | undefined) {
  const normalized = value?.normalize('NFD').replace(accentPattern, '').toUpperCase().replace(/[^A-Z0-9]/g, '') ?? ''
  return normalized.length >= 6 ? normalized : null
}

export function normalizeSupplierName(value: string) {
  const tokens = normalizeDocumentText(value).split(' ').filter(Boolean)
  for (const suffix of [['s', 'l', 'u'], ['s', 'a', 'u'], ['s', 'c', 'p'], ['s', 'l'], ['s', 'a'], ['s', 'c']]) {
    if (suffix.every((token, index) => tokens[tokens.length - suffix.length + index] === token)) {
      tokens.splice(tokens.length - suffix.length, suffix.length)
      break
    }
  }
  return tokens.filter((token) => !supplierLegalFormTokens.has(token)).join(' ')
}

export function supplierIdentityMatches(
  supplier: { name: string; taxId?: string | null },
  candidate: { name: string; taxId?: string | null },
) {
  const supplierTaxId = normalizeSupplierTaxId(supplier.taxId)
  const candidateTaxId = normalizeSupplierTaxId(candidate.taxId)
  if (supplierTaxId && candidateTaxId) return supplierTaxId === candidateTaxId

  const supplierName = normalizeSupplierName(supplier.name)
  const candidateName = normalizeSupplierName(candidate.name)
  if (!supplierName || !candidateName) return false
  if (supplierName === candidateName) return true

  const supplierTokens = new Set(supplierName.split(' '))
  const candidateTokens = new Set(candidateName.split(' '))
  const shortestSize = Math.min(supplierTokens.size, candidateTokens.size)
  if (shortestSize < 3) return false
  const shared = [...supplierTokens].filter((token) => candidateTokens.has(token)).length
  return shared / shortestSize >= 0.8 && Math.abs(supplierTokens.size - candidateTokens.size) <= 2
}

export function profileMatchesOcr(rules: SupplierProfileRules, ocr: OcrDocument) {
  const haystack = normalizeDocumentText(ocr.text)
  return rules.requiredTexts.every((text) => haystack.includes(normalizeDocumentText(text)))
}

function tableMatrix(table: OcrTable) {
  const matrix = Array.from({ length: table.rowCount }, () => Array<string>(table.columnCount).fill(''))
  for (const cell of table.cells) {
    if (matrix[cell.rowIndex]?.[cell.columnIndex] !== undefined) matrix[cell.rowIndex][cell.columnIndex] = cell.text
  }
  return matrix
}

function parseProfileNumber(rawValue: string, rules: SupplierProfileRules) {
  const raw = rawValue.replace(/[^\d,.-]/g, '').trim()
  if (!raw) return null
  const thousands = rules.thousandsSeparator === 'none' ? '' : rules.thousandsSeparator
  const normalized = (thousands ? raw.split(thousands).join('') : raw)
    .replace(rules.decimalSeparator, '.')
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

function normalizeProfileField(value: string, field: z.infer<typeof parserFieldSchema>, rules: SupplierProfileRules) {
  let result = value
  for (const normalization of rules.normalizations) {
    if (normalization.field !== field) continue
    if (normalization.operation === 'trim') result = result.trim()
    if (normalization.operation === 'collapse_spaces') result = result.replace(spacesPattern, ' ').trim()
    if (normalization.operation === 'uppercase') result = result.toUpperCase()
    if (normalization.operation === 'lowercase') result = result.toLowerCase()
  }
  return result.trim()
}

function extractLabelValue(text: string, label: string | null) {
  if (!label) return null
  const normalizedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`${normalizedLabel}\\s*[:#-]?\\s*([^\\n|]+)`, 'i'))
  return match?.[1]?.trim() || null
}

function rowMatchesAliases(normalizedRow: string, aliases: string[]) {
  return aliases.some((alias) => normalizedRow.includes(normalizeDocumentText(alias)))
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

export function runDeterministicParser(
  inputRules: SupplierProfileRules | unknown,
  ocrInput: OcrDocument | unknown,
  defaults: { documentType: 'invoice' | 'delivery_note'; supplierName: string; supplierTaxId?: string | null },
): SupplierDocumentExtraction {
  const rules = supplierProfileRulesSchema.parse(inputRules)
  const ocr = ocrDocumentSchema.parse(ocrInput)
  if (!profileMatchesOcr(rules, ocr)) throw new Error('PROFILE_FINGERPRINT_MISMATCH')
  let selected: { lines: ExtractedLine[]; score: number } | null = null
  let matchedHeaders = false
  for (const page of ocr.pages) {
    for (const table of page.tables) {
      const matrix = tableMatrix(table)
      const normalizedTableText = normalizeDocumentText(matrix.flat().join(' '))
      for (let headerRowIndex = 0; headerRowIndex < matrix.length; headerRowIndex += 1) {
        const headers = matrix[headerRowIndex]?.map(normalizeDocumentText) ?? []
        const indexes = new Map<z.infer<typeof parserFieldSchema>, number>()
        for (const column of rules.columns) {
          const index = headers.findIndex((header) => column.headerAliases.some((alias) => header.includes(normalizeDocumentText(alias))))
          if (index >= 0) indexes.set(column.field, index)
        }
        const requiredColumns = rules.columns.filter((column) => column.required)
        if (!requiredColumns.every((column) => indexes.has(column.field))) continue
        matchedHeaders = true
        const lines: ExtractedLine[] = []
        const dataRows = matrix.slice(headerRowIndex + 1)
        let tableEnded = false
        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
          const row = dataRows[rowIndex]
          const normalizedRow = normalizeDocumentText(row.join(' '))
          if (rules.tableEndText && normalizedRow.includes(normalizeDocumentText(rules.tableEndText))) break
          const get = (sourceRow: string[], field: z.infer<typeof parserFieldSchema>) => {
            const index = indexes.get(field)
            return index === undefined ? '' : normalizeProfileField(sourceRow[index] ?? '', field, rules)
          }
          const description = get(row, 'description')
          const quantity = parseProfileNumber(get(row, 'quantity'), rules)
          if (!description || quantity === null || quantity <= 0) continue
          const unitPrice = parseProfileNumber(get(row, 'unitPrice'), rules)
          let discountAmount = Math.abs(parseProfileNumber(get(row, 'discountAmount'), rules) ?? 0)
          let chargesAmount = 0
          const mainRowTotal = parseProfileNumber(get(row, 'lineTotal'), rules)
          const grossCost = unitPrice === null ? mainRowTotal : roundMoney(quantity * unitPrice)
          let groupedNetTotal: number | null = null

          if (rules.lineGroup) {
            const continuationLimit = Math.min(dataRows.length, rowIndex + 1 + rules.lineGroup.maxContinuationRows)
            let continuationIndex = rowIndex + 1
            for (; continuationIndex < continuationLimit; continuationIndex += 1) {
              const continuationRow = dataRows[continuationIndex]
              const continuationText = normalizeDocumentText(continuationRow.join(' '))
              const continuationDescription = get(continuationRow, 'description')
              const continuationQuantity = parseProfileNumber(get(continuationRow, 'quantity'), rules)
              if (continuationDescription && continuationQuantity !== null && continuationQuantity > 0) break

              const amount = parseProfileNumber(get(continuationRow, 'lineTotal'), rules)
              if (rowMatchesAliases(continuationText, rules.lineGroup.endAliases)) {
                if (rules.lineGroup.netTotalFromEndRow && amount !== null) groupedNetTotal = Math.abs(amount)
                continuationIndex += 1
                break
              }
              if (rules.tableEndText && continuationText.includes(normalizeDocumentText(rules.tableEndText))) {
                tableEnded = true
                break
              }
              if (rowMatchesAliases(continuationText, rules.lineGroup.discountAliases)) {
                if (amount !== null) discountAmount = roundMoney(discountAmount + Math.abs(amount))
                continue
              }
              if (rowMatchesAliases(continuationText, rules.lineGroup.chargeAliases)) {
                if (amount !== null) chargesAmount = roundMoney(chargesAmount + Math.abs(amount))
              }
            }
            rowIndex = continuationIndex - 1
          }

          const calculatedNetTotal = grossCost === null
            ? mainRowTotal
            : roundMoney(grossCost - discountAmount + chargesAmount)
          const lineTotal = rules.lineGroup ? (groupedNetTotal ?? calculatedNetTotal) : mainRowTotal
          const taxRate = parseProfileNumber(get(row, 'taxRate'), rules)
          const parsedLine = extractedLineSchema.safeParse({
            supplierReference: get(row, 'supplierReference') || null,
            description,
            barcode: get(row, 'barcode') || null,
            quantity,
            purchaseUnit: get(row, 'purchaseUnit') || null,
            unitPrice,
            discountAmount,
            chargesAmount,
            grossCost,
            netCost: lineTotal,
            lineTotal,
            taxRate,
            packageExpression: packagingPattern.exec(description)?.[0] ?? null,
            confidence: ocr.confidence,
          })
          if (parsedLine.success) lines.push(parsedLine.data)
          if (tableEnded) break
        }
        if (lines.length === 0) continue
        const markerScore = [rules.tableStartText, rules.tableEndText]
          .filter((marker): marker is string => Boolean(marker))
          .filter((marker) => normalizedTableText.includes(normalizeDocumentText(marker))).length
        const score = lines.length * 1_000 + indexes.size * 10 + markerScore * 100 - headerRowIndex
        if (!selected || score > selected.score) selected = { lines, score }
      }
    }
  }
  if (!selected) throw new Error(matchedHeaders ? 'PROFILE_LINES_NOT_FOUND' : 'PROFILE_TABLE_NOT_FOUND')
  const lines = selected.lines
  return supplierDocumentExtractionSchema.parse({
    document: {
      type: defaults.documentType,
      number: extractLabelValue(ocr.text, rules.documentNumberLabel),
      date: extractLabelValue(ocr.text, rules.documentDateLabel),
      total: lines.every((line) => line.lineTotal !== null)
        ? lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0)
        : null,
    },
    supplier: { name: defaults.supplierName, taxId: defaults.supplierTaxId ?? null },
    lines,
    proposedProfile: null,
    confidence: ocr.confidence,
  })
}

export type MathValidation = {
  coherent: boolean
  documentDifference: number | null
  invalidLineIndexes: number[]
}

export function validateExtractionMath(extractionInput: SupplierDocumentExtraction | unknown, tolerance = 0.03): MathValidation {
  const extraction = supplierDocumentExtractionSchema.parse(extractionInput)
  const invalidLineIndexes: number[] = []
  extraction.lines.forEach((line, index) => {
    if (line.unitPrice === null || line.lineTotal === null) return
    const expected = line.quantity * line.unitPrice - line.discountAmount + line.chargesAmount
    const allowed = Math.max(0.02, Math.abs(line.lineTotal) * tolerance)
    if (Math.abs(expected - line.lineTotal) > allowed) invalidLineIndexes.push(index)
  })
  const comparableLines = extraction.lines.filter((line) => line.lineTotal !== null)
  const documentDifference = extraction.document.total === null || comparableLines.length !== extraction.lines.length
    ? null
    : (() => {
        const lineTotal = comparableLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0)
        const taxInclusiveTotal = comparableLines.reduce(
          (sum, line) => sum + (line.lineTotal ?? 0) * (1 + (line.taxRate ?? 0) / 100),
          0,
        )
        return Math.min(
          Math.abs(lineTotal - extraction.document.total),
          Math.abs(taxInclusiveTotal - extraction.document.total),
        )
      })()
  const documentAllowed = extraction.document.total === null ? 0 : Math.max(0.05, extraction.document.total * tolerance)
  return {
    coherent: invalidLineIndexes.length === 0 && (documentDifference === null || documentDifference <= documentAllowed),
    documentDifference,
    invalidLineIndexes,
  }
}

export function validateProposedProfile(ocr: OcrDocument, interpreted: SupplierDocumentExtraction) {
  if (!interpreted.proposedProfile) return { candidate: false, reason: 'PROFILE_NOT_PROPOSED' as const, parsed: null }
  try {
    const rules = supplierProfileRulesSchema.parse(interpreted.proposedProfile)
    if (rules.lineGroup) {
      const ocrText = normalizeDocumentText([
        ocr.text,
        ...ocr.pages.flatMap((page) => page.tables.flatMap((table) => table.cells.map((cell) => cell.text))),
      ].join(' '))
      const aliases = [
        ...rules.lineGroup.endAliases,
        ...rules.lineGroup.discountAliases,
        ...rules.lineGroup.chargeAliases,
      ]
      if (aliases.some((alias) => !ocrText.includes(normalizeDocumentText(alias)))) {
        return { candidate: false, reason: 'PROFILE_LINE_GROUP_ALIAS_NOT_IN_OCR' as const, parsed: null }
      }
    }
    const parsed = runDeterministicParser(rules, ocr, {
      documentType: interpreted.document.type,
      supplierName: interpreted.supplier.name,
      supplierTaxId: interpreted.supplier.taxId,
    })
    const parserMath = validateExtractionMath(parsed)
    const interpretationMath = validateExtractionMath(interpreted)
    const sameLineCount = parsed.lines.length === interpreted.lines.length
    const comparable = sameLineCount && parsed.lines.every((line, index) => {
      const expected = interpreted.lines[index]
      const sameMoney = (actual: number | null, target: number | null) => (
        actual === null || target === null ? actual === target : Math.abs(actual - target) <= 0.02
      )
      return normalizeDocumentText(line.description) === normalizeDocumentText(expected.description)
        && Math.abs(line.quantity - expected.quantity) <= 0.000001
        && Math.abs(line.discountAmount - expected.discountAmount) <= 0.02
        && Math.abs(line.chargesAmount - expected.chargesAmount) <= 0.02
        && sameMoney(line.grossCost, expected.grossCost)
        && sameMoney(line.netCost, expected.netCost)
        && sameMoney(line.lineTotal, expected.lineTotal)
    })
    return {
      candidate: parserMath.coherent && interpretationMath.coherent && comparable,
      reason: parserMath.coherent && interpretationMath.coherent && comparable ? null : 'PROFILE_OUTPUT_MISMATCH',
      parsed,
    }
  } catch (error) {
    return { candidate: false, reason: error instanceof Error ? error.message : 'PROFILE_INVALID', parsed: null }
  }
}

type UnitDimension = 'mass' | 'volume' | 'count'
type CanonicalUnit = { dimension: UnitDimension; factor: number; symbol: 'kg' | 'L' | 'ud' }

const canonicalUnits: Record<string, CanonicalUnit> = {
  kg: { dimension: 'mass', factor: 1, symbol: 'kg' },
  g: { dimension: 'mass', factor: 0.001, symbol: 'kg' },
  l: { dimension: 'volume', factor: 1, symbol: 'L' },
  cl: { dimension: 'volume', factor: 0.01, symbol: 'L' },
  ml: { dimension: 'volume', factor: 0.001, symbol: 'L' },
  ud: { dimension: 'count', factor: 1, symbol: 'ud' },
  uds: { dimension: 'count', factor: 1, symbol: 'ud' },
  unidad: { dimension: 'count', factor: 1, symbol: 'ud' },
  unidades: { dimension: 'count', factor: 1, symbol: 'ud' },
  pieza: { dimension: 'count', factor: 1, symbol: 'ud' },
  piezas: { dimension: 'count', factor: 1, symbol: 'ud' },
  botella: { dimension: 'count', factor: 1, symbol: 'ud' },
  botellas: { dimension: 'count', factor: 1, symbol: 'ud' },
  lata: { dimension: 'count', factor: 1, symbol: 'ud' },
  latas: { dimension: 'count', factor: 1, symbol: 'ud' },
}

export type ParsedPackaging = {
  packageCount: number
  unitQuantity: number
  unitSymbol: string
  canonicalQuantity: number
  canonicalSymbol: string
  dimension: UnitDimension
}

export function parsePackagingExpression(value: string): ParsedPackaging | null {
  const match = packagingPattern.exec(value)
  if (!match) return null
  const packageCount = match[1] ? Number(match[1].replace(',', '.')) : 1
  const unitQuantity = Number(match[2].replace(',', '.'))
  const rawSymbol = match[3].toLowerCase()
  const unit = canonicalUnits[rawSymbol]
  if (!unit || !(packageCount > 0) || !(unitQuantity > 0)) return null
  return {
    packageCount,
    unitQuantity,
    unitSymbol: rawSymbol,
    canonicalQuantity: packageCount * unitQuantity * unit.factor,
    canonicalSymbol: unit.symbol,
    dimension: unit.dimension,
  }
}

export type InventoryUnitDefinition = {
  id: string
  symbol: string
  name: string
  contentQuantity: number
  contentUnitId: string
}

function inventoryContentUnit(unit: InventoryUnitDefinition, units: InventoryUnitDefinition[]) {
  return units.find((candidate) => candidate.id === unit.contentUnitId) ?? unit
}

const countUnitPattern = /(unidad|pieza|botell|lata|envase)/
const countUnitSymbolPattern = /^(u|ud|uds|pz|bot|b)$/

export function inventoryUnitsCompatible(
  leftUnit: InventoryUnitDefinition,
  rightUnit: InventoryUnitDefinition,
  units: InventoryUnitDefinition[],
) {
  const leftBase = inventoryContentUnit(leftUnit, units)
  const rightBase = inventoryContentUnit(rightUnit, units)
  const leftName = normalizeDocumentText(leftBase.name)
  const rightName = normalizeDocumentText(rightBase.name)
  const leftSymbol = normalizeDocumentText(leftBase.symbol)
  const rightSymbol = normalizeDocumentText(rightBase.symbol)
  const leftIsCount = countUnitPattern.test(leftName) || countUnitSymbolPattern.test(leftSymbol)
  const rightIsCount = countUnitPattern.test(rightName) || countUnitSymbolPattern.test(rightSymbol)
  return leftBase.id === rightBase.id
    || leftName === rightName
    || (leftSymbol !== '' && leftSymbol === rightSymbol)
    || (leftIsCount && rightIsCount)
}

function convertInventoryQuantity(
  quantity: number,
  fromUnit: InventoryUnitDefinition,
  toUnit: InventoryUnitDefinition,
  units: InventoryUnitDefinition[],
) {
  if (!(quantity > 0) || !inventoryUnitsCompatible(fromUnit, toUnit, units)) return null
  if (!(fromUnit.contentQuantity > 0) || !(toUnit.contentQuantity > 0)) return null
  return Math.round((quantity * fromUnit.contentQuantity / toUnit.contentQuantity) * 1_000_000) / 1_000_000
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseInventoryPackagingExpression(value: string, units: InventoryUnitDefinition[]) {
  const candidates = units.flatMap((unit) => [unit.symbol, unit.name]
    .filter((label, index, labels) => label.trim() && labels.indexOf(label) === index)
    .map((label) => ({ label, unit })))
    .sort((left, right) => right.label.length - left.label.length)
  for (const candidate of candidates) {
    const pattern = new RegExp(
      `(?:(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*)?(\\d+(?:[.,]\\d+)?)\\s*${escapeRegularExpression(candidate.label)}(?=$|[^\\p{L}\\p{N}])`,
      'iu',
    )
    const match = pattern.exec(value)
    if (!match) continue
    const packageCount = match[1] ? Number(match[1].replace(',', '.')) : 1
    const unitQuantity = Number(match[2].replace(',', '.'))
    if (!(packageCount > 0) || !(unitQuantity > 0)) return null
    return { packageCount, unitQuantity, unit: candidate.unit }
  }
  return null
}

function canonicalUnitForInventoryUnit(unit: InventoryUnitDefinition, units: InventoryUnitDefinition[]) {
  const contentUnit = units.find((candidate) => candidate.id === unit.contentUnitId) ?? unit
  return canonicalUnits[normalizeDocumentText(contentUnit.symbol || contentUnit.name)] ?? null
}

export function normalizePurchaseToBase(input: {
  purchaseQuantity: number
  purchaseUnit: string | null
  packageExpression: string | null
  description: string
  baseUnit: InventoryUnitDefinition
  units: InventoryUnitDefinition[]
  packageCount?: number | null
  packageUnitQuantity?: number | null
  packageUnitId?: string | null
}) {
  if (!(input.purchaseQuantity > 0)) return null
  if (input.packageUnitId) {
    const packageUnit = input.units.find((unit) => unit.id === input.packageUnitId)
    if (!packageUnit || !(input.packageCount && input.packageCount > 0)
      || !(input.packageUnitQuantity && input.packageUnitQuantity > 0)) return null
    const baseQuantity = convertInventoryQuantity(
      input.purchaseQuantity * input.packageCount * input.packageUnitQuantity,
      packageUnit,
      input.baseUnit,
      input.units,
    )
    if (baseQuantity === null) return null
    return {
      baseQuantity,
      packaging: {
        packageCount: input.packageCount,
        unitQuantity: input.packageUnitQuantity,
        unitSymbol: packageUnit.symbol,
      },
    }
  }
  const inventoryPackaging = parseInventoryPackagingExpression(
    input.packageExpression ?? input.description,
    input.units,
  )
  if (inventoryPackaging) {
    const baseQuantity = convertInventoryQuantity(
      input.purchaseQuantity * inventoryPackaging.packageCount * inventoryPackaging.unitQuantity,
      inventoryPackaging.unit,
      input.baseUnit,
      input.units,
    )
    if (baseQuantity === null) return null
    return {
      baseQuantity,
      packaging: {
        packageCount: inventoryPackaging.packageCount,
        unitQuantity: inventoryPackaging.unitQuantity,
        unitSymbol: inventoryPackaging.unit.symbol,
      },
    }
  }
  const baseCanonical = canonicalUnitForInventoryUnit(input.baseUnit, input.units)
  if (!baseCanonical) return null
  const purchaseUnit = normalizeDocumentText(input.purchaseUnit ?? '')
  const packaging = parsePackagingExpression(input.packageExpression ?? input.description)
  const isPackage = /^(caja|cajas|paquete|paquetes|pack|packs)$/.test(purchaseUnit)
  let canonicalQuantity: number
  let packagingResult: ParsedPackaging | null = packaging
  if (isPackage) {
    if (!packaging || packaging.dimension !== baseCanonical.dimension) return null
    canonicalQuantity = input.purchaseQuantity * packaging.canonicalQuantity
  } else {
    const directUnit = canonicalUnits[purchaseUnit]
    if (directUnit) {
      if (directUnit.dimension !== baseCanonical.dimension) return null
      canonicalQuantity = input.purchaseQuantity * directUnit.factor
      packagingResult = null
    } else if (packaging && packaging.dimension === baseCanonical.dimension) {
      canonicalQuantity = input.purchaseQuantity * packaging.canonicalQuantity
    } else {
      return null
    }
  }
  const baseFactor = input.baseUnit.contentQuantity * baseCanonical.factor
  if (!(baseFactor > 0)) return null
  return {
    baseQuantity: Math.round((canonicalQuantity / baseFactor) * 1_000_000) / 1_000_000,
    packaging: packagingResult,
  }
}

export type MatchableInventoryItem = {
  id: string
  name: string
  baseUnitId: string
  referenceCost: number | null
  active: boolean
}

export type SupplierAlias = {
  aliasType: 'ean' | 'supplier_reference' | 'description'
  aliasValue: string
  inventoryItemId: string
  packageExpression?: string | null
}

export type InventoryMatch = {
  inventoryItemId: string | null
  status: 'recognized' | 'probable' | 'needs_review'
  reason: 'ean' | 'supplier_reference' | 'alias' | 'name_format' | 'approximate' | 'none'
  score: number
  packageExpression?: string | null
}

function diceCoefficient(left: string, right: string) {
  const leftTokens = new Set(normalizeDocumentText(left).split(' ').filter(Boolean))
  const rightTokens = new Set(normalizeDocumentText(right).split(' ').filter(Boolean))
  if (!leftTokens.size || !rightTokens.size) return 0
  let intersection = 0
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
  return (2 * intersection) / (leftTokens.size + rightTokens.size)
}

export function matchInventoryItem(
  line: Pick<ExtractedLine, 'barcode' | 'supplierReference' | 'description' | 'packageExpression'>,
  items: MatchableInventoryItem[],
  aliases: SupplierAlias[],
): InventoryMatch {
  const activeItems = new Map(items.filter((item) => item.active).map((item) => [item.id, item]))
  const findAlias = (type: SupplierAlias['aliasType'], value: string | null) => {
    if (!value) return null
    const normalized = type === 'ean'
      ? value.replace(/[^0-9a-z]/gi, '').toLowerCase()
      : type === 'supplier_reference'
        ? value.trim().toLowerCase()
        : normalizeAlias(value)
    return aliases.find((alias) => alias.aliasType === type && alias.aliasValue === normalized && activeItems.has(alias.inventoryItemId)) ?? null
  }
  const ean = findAlias('ean', line.barcode)
  if (ean) return { inventoryItemId: ean.inventoryItemId, status: 'recognized', reason: 'ean', score: 1, packageExpression: ean.packageExpression }
  const reference = findAlias('supplier_reference', line.supplierReference)
  if (reference) return { inventoryItemId: reference.inventoryItemId, status: 'recognized', reason: 'supplier_reference', score: 1, packageExpression: reference.packageExpression }
  const descriptionAlias = findAlias('description', line.description)
  if (descriptionAlias) return { inventoryItemId: descriptionAlias.inventoryItemId, status: 'recognized', reason: 'alias', score: 0.99, packageExpression: descriptionAlias.packageExpression }
  const normalizedDescription = normalizeDocumentText(`${line.description} ${line.packageExpression ?? ''}`)
  const exact = items.find((item) => item.active && normalizedDescription.includes(normalizeDocumentText(item.name)))
  if (exact) return { inventoryItemId: exact.id, status: 'recognized', reason: 'name_format', score: 0.96 }
  let best: MatchableInventoryItem | null = null
  let bestScore = 0
  for (const item of items) {
    if (!item.active) continue
    const score = diceCoefficient(normalizedDescription, item.name)
    if (score > bestScore) { best = item; bestScore = score }
  }
  if (best && bestScore >= 0.72) {
    return { inventoryItemId: best.id, status: 'probable', reason: 'approximate', score: bestScore }
  }
  return { inventoryItemId: null, status: 'needs_review', reason: 'none', score: bestScore }
}

export function chooseDefaultWarehouse(
  inventoryItemId: string,
  routes: Array<{ inventoryItemId: string; warehouseId: string; priority: number; enabled: boolean }>,
  warehouses: Array<{ id: string; active: boolean; sortOrder: number }>,
) {
  const activeWarehouses = new Set(warehouses.filter((warehouse) => warehouse.active).map((warehouse) => warehouse.id))
  return routes
    .filter((route) => route.inventoryItemId === inventoryItemId && route.enabled && activeWarehouses.has(route.warehouseId))
    .toSorted((left, right) => left.priority - right.priority || left.warehouseId.localeCompare(right.warehouseId))[0]?.warehouseId ?? null
}
