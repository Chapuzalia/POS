import {
  ocrDocumentSchema,
  supplierDocumentExtractionJsonSchema,
  supplierDocumentExtractionSchema,
  supplierProfileRulesJsonSchema,
  supplierProfileRulesSchema,
  type OcrDocument,
  type SupplierCandidate,
  type SupplierDocumentExtraction,
  type SupplierProfileRules,
} from './core.ts'
import { getSupplierDocumentMockFixture } from './fixtures.ts'

export type DocumentBinaryInput = {
  bytes: Uint8Array
  contentType: string
  fileName: string
}

export interface DocumentOcrProvider {
  readonly name: string
  analyze(input: DocumentBinaryInput): Promise<OcrDocument>
}

export interface SupplierDocumentAiProvider {
  readonly name: string
  interpret(input: {
    ocr: OcrDocument
    documentType: 'invoice' | 'delivery_note'
    imageDataUrl?: string | null
    supplierCandidates: SupplierCandidate[]
  }): Promise<SupplierDocumentExtraction>
  proposeProfile(input: {
    ocr: OcrDocument
    documentType: 'invoice' | 'delivery_note'
    extraction: SupplierDocumentExtraction
  }): Promise<SupplierProfileRules>
}

export interface NativePdfTextExtractor {
  extract(input: DocumentBinaryInput): Promise<OcrDocument | null>
}

export class ProviderConfigurationError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED'

  constructor(provider: string, missingVariables: string[]) {
    super(`${provider} no está configurado. Faltan: ${missingVariables.join(', ')}`)
    this.name = 'ProviderConfigurationError'
  }
}

export class NoopNativePdfTextExtractor implements NativePdfTextExtractor {
  async extract(_input: DocumentBinaryInput) {
    return null
  }
}

export type AzureConfig = {
  endpoint: string
  apiKey: string
  apiVersion?: string
  modelId?: string
  pollTimeoutMs?: number
}

type AzureCell = {
  rowIndex?: number
  columnIndex?: number
  rowSpan?: number
  columnSpan?: number
  content?: string
  confidence?: number
  polygon?: number[]
  boundingRegions?: Array<{ pageNumber?: number; polygon?: number[] }>
}

type AzureAnalyzeResult = {
  status?: string
  error?: { code?: string; message?: string }
  analyzeResult?: {
    content?: string
    pages?: Array<{
      pageNumber?: number
      width?: number
      height?: number
      unit?: string
      words?: Array<{ content?: string; confidence?: number; polygon?: number[] }>
      lines?: Array<{ content?: string }>
    }>
    tables?: Array<{ rowCount?: number; columnCount?: number; cells?: AzureCell[] }>
  }
}

function polygon(value: number[] | undefined) {
  return value && value.length >= 4 ? value : [0, 0, 0, 0]
}

export class AzureDocumentOcrProvider implements DocumentOcrProvider {
  readonly name = 'azure'
  private readonly config: AzureConfig
  private readonly apiVersion: string
  private readonly modelId: string
  private readonly pollTimeoutMs: number

  constructor(config: AzureConfig) {
    if (!config.endpoint || !config.apiKey) {
      const missing = [!config.endpoint && 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', !config.apiKey && 'AZURE_DOCUMENT_INTELLIGENCE_API_KEY'].filter(Boolean) as string[]
      throw new ProviderConfigurationError('Azure Document Intelligence', missing)
    }
    this.apiVersion = config.apiVersion || '2024-11-30'
    this.modelId = config.modelId || 'prebuilt-layout'
    this.pollTimeoutMs = config.pollTimeoutMs ?? 60_000
    this.config = config
  }

  async analyze(input: DocumentBinaryInput) {
    const endpoint = this.config.endpoint.replace(/\/$/, '')
    const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(this.modelId)}:analyze?api-version=${encodeURIComponent(this.apiVersion)}`
    const started = await fetch(analyzeUrl, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': this.config.apiKey, 'Content-Type': input.contentType },
      body: new Blob([Uint8Array.from(input.bytes)], { type: input.contentType }),
    })
    if (!started.ok) throw new Error(`AZURE_OCR_START_FAILED:${started.status}:${await started.text()}`)
    const operationLocation = started.headers.get('operation-location')
    if (!operationLocation) throw new Error('AZURE_OCR_OPERATION_LOCATION_MISSING')
    const deadline = Date.now() + this.pollTimeoutMs
    let payload: AzureAnalyzeResult | null = null
    while (Date.now() < deadline) {
      const result = await fetch(operationLocation, { headers: { 'Ocp-Apim-Subscription-Key': this.config.apiKey } })
      if (!result.ok) throw new Error(`AZURE_OCR_RESULT_FAILED:${result.status}:${await result.text()}`)
      payload = await result.json() as AzureAnalyzeResult
      if (payload.status === 'succeeded') break
      if (payload.status === 'failed') throw new Error(`AZURE_OCR_ANALYSIS_FAILED:${payload.error?.code ?? 'unknown'}:${payload.error?.message ?? ''}`)
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    if (!payload || payload.status !== 'succeeded' || !payload.analyzeResult?.pages?.length) {
      throw new Error('AZURE_OCR_TIMEOUT')
    }
    const tablesByPage = new Map<number, NonNullable<OcrDocument['pages'][number]['tables']>>()
    for (const table of payload.analyzeResult.tables ?? []) {
      const pageNumber = table.cells?.flatMap((cell) => cell.boundingRegions ?? []).find((region) => region.pageNumber)?.pageNumber ?? 1
      const mapped = {
        rowCount: table.rowCount ?? 1,
        columnCount: table.columnCount ?? 1,
        cells: (table.cells ?? []).map((cell) => ({
          rowIndex: cell.rowIndex ?? 0,
          columnIndex: cell.columnIndex ?? 0,
          rowSpan: cell.rowSpan ?? 1,
          columnSpan: cell.columnSpan ?? 1,
          text: cell.content ?? '',
          confidence: cell.confidence ?? 0.5,
          polygon: polygon(cell.boundingRegions?.[0]?.polygon ?? cell.polygon),
        })),
      }
      tablesByPage.set(pageNumber, [...(tablesByPage.get(pageNumber) ?? []), mapped])
    }
    const pages = payload.analyzeResult.pages.map((page, index) => {
      const words = (page.words ?? []).map((word) => ({
        text: word.content ?? '',
        confidence: word.confidence ?? 0.5,
        polygon: polygon(word.polygon),
      }))
      const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0.5
      return {
        pageNumber: page.pageNumber ?? index + 1,
        width: page.width ?? 1,
        height: page.height ?? 1,
        unit: page.unit ?? 'pixel',
        text: (page.lines ?? []).map((line) => line.content ?? '').join('\n'),
        words,
        tables: tablesByPage.get(page.pageNumber ?? index + 1) ?? [],
        confidence,
      }
    })
    return ocrDocumentSchema.parse({
      pages,
      text: payload.analyzeResult.content ?? pages.map((page) => page.text).join('\n'),
      confidence: pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length,
      provider: this.name,
      metadata: { apiVersion: this.apiVersion, modelId: this.modelId },
    })
  }
}

export type MistralConfig = {
  apiKey: string
  model?: string
}

type MistralConfidenceScore = {
  text?: string
  confidence?: number
  start_index?: number
}

type MistralBlock = {
  type?: string
  content?: string
  top_left_x?: number
  top_left_y?: number
  bottom_right_x?: number
  bottom_right_y?: number
  table_id?: string
  image_id?: string
  confidence_scores?: { average_content_confidence_score?: number }
}

type MistralTable = {
  id?: string
  content?: string
  format?: string
  word_confidence_scores?: MistralConfidenceScore[]
}

export type MistralOcrResponse = {
  model?: string
  pages?: Array<{
    index?: number
    markdown?: string
    dimensions?: { dpi?: number; height?: number; width?: number }
    confidence_scores?: {
      average_page_confidence_score?: number
      minimum_page_confidence_score?: number
      word_confidence_scores?: MistralConfidenceScore[]
    }
    blocks?: MistralBlock[] | null
    tables?: MistralTable[]
  }>
  usage_info?: Record<string, unknown>
}

function dataUrl(bytes: Uint8Array, contentType: string) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return `data:${contentType};base64,${btoa(binary)}`
}

function mistralNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mistralConfidence(value: unknown) {
  const parsed = mistralNumber(value)
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined
}

function mistralPolygon(value: MistralBlock | undefined) {
  if (!value) return undefined
  const left = mistralNumber(value.top_left_x)
  const top = mistralNumber(value.top_left_y)
  const right = mistralNumber(value.bottom_right_x)
  const bottom = mistralNumber(value.bottom_right_y)
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) return undefined
  return [left, top, right, top, right, bottom, left, bottom]
}

function markdownCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of trimmed) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current.trim())
  return cells
}

function markdownTable(content: string, tableBlock?: MistralBlock) {
  const rows = content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map(markdownCells)
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
  const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  if (!rows.length || !columnCount) return null
  return {
    rowCount: rows.length,
    columnCount,
    cells: rows.flatMap((row, rowIndex) => Array.from({ length: columnCount }, (_, columnIndex) => ({
      rowIndex,
      columnIndex,
      text: row[columnIndex] ?? '',
    }))),
    polygon: mistralPolygon(tableBlock),
  }
}

export function normalizeMistralOcrResponse(payload: MistralOcrResponse): OcrDocument {
  if (!payload.pages?.length) throw new Error('MISTRAL_OCR_EMPTY')
  if (!payload.model) throw new Error('MISTRAL_OCR_MODEL_MISSING')
  const pages = payload.pages.map((page, pageIndex) => {
    const mistralPageIndex = page.index
    if (typeof mistralPageIndex !== 'number' || !Number.isInteger(mistralPageIndex) || mistralPageIndex < 0) {
      throw new Error(`MISTRAL_OCR_PAGE_INDEX_INVALID:${pageIndex}`)
    }
    if (typeof page.markdown !== 'string') throw new Error(`MISTRAL_OCR_PAGE_TEXT_MISSING:${pageIndex}`)
    const width = mistralNumber(page.dimensions?.width)
    const height = mistralNumber(page.dimensions?.height)
    if (!width || !height) throw new Error(`MISTRAL_OCR_DIMENSIONS_MISSING:${pageIndex}`)
    const wordScores = page.confidence_scores?.word_confidence_scores ?? []
    const wordConfidences = wordScores.map((word) => mistralConfidence(word.confidence)).filter((value): value is number => value !== undefined)
    const pageConfidence = mistralConfidence(page.confidence_scores?.average_page_confidence_score)
      ?? (wordConfidences.length ? wordConfidences.reduce((sum, value) => sum + value, 0) / wordConfidences.length : undefined)
    if (pageConfidence === undefined) throw new Error(`MISTRAL_OCR_CONFIDENCE_MISSING:${pageIndex}`)
    const blocks = (page.blocks ?? []).map((block, blockIndex) => {
      const blockPolygon = mistralPolygon(block)
      if (!blockPolygon || typeof block.type !== 'string' || typeof block.content !== 'string') {
        throw new Error(`MISTRAL_OCR_BLOCK_INVALID:${pageIndex}:${blockIndex}`)
      }
      const confidence = mistralConfidence(block.confidence_scores?.average_content_confidence_score)
      return {
        type: block.type,
        text: block.content,
        polygon: blockPolygon,
        ...(confidence === undefined ? {} : { confidence }),
        ...(block.table_id ? { tableId: block.table_id } : {}),
        ...(block.image_id ? { imageId: block.image_id } : {}),
      }
    })
    const tables = (page.tables ?? []).flatMap((table) => {
      if (table.format !== 'markdown' || typeof table.content !== 'string') return []
      const tableBlock = (page.blocks ?? []).find((block) => block.type === 'table' && block.table_id === table.id)
      const normalized = markdownTable(table.content, tableBlock)
      return normalized ? [normalized] : []
    })
    return {
      pageNumber: mistralPageIndex + 1,
      width,
      height,
      unit: 'pixel',
      text: page.markdown,
      words: wordScores.flatMap((word) => {
        const confidence = mistralConfidence(word.confidence)
        return typeof word.text === 'string' && confidence !== undefined ? [{ text: word.text, confidence }] : []
      }),
      blocks,
      tables,
      confidence: pageConfidence,
    }
  })
  return ocrDocumentSchema.parse({
    pages,
    text: pages.map((page) => page.text).join('\n'),
    confidence: pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length,
    provider: 'mistral',
    metadata: { model: payload.model, usageInfo: payload.usage_info ?? null },
  })
}

export class MistralDocumentOcrProvider implements DocumentOcrProvider {
  readonly name = 'mistral'
  private readonly apiKey: string
  private readonly model: string

  constructor(config: MistralConfig) {
    if (!config.apiKey) throw new ProviderConfigurationError('Mistral OCR', ['MISTRAL_API_KEY'])
    this.apiKey = config.apiKey
    this.model = config.model || 'mistral-ocr-latest'
  }

  async analyze(input: DocumentBinaryInput) {
    const encodedDocument = dataUrl(input.bytes, input.contentType)
    const document = input.contentType.startsWith('image/')
      ? { type: 'image_url', image_url: encodedDocument }
      : { type: 'document_url', document_url: encodedDocument, document_name: input.fileName }
    const response = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        document,
        table_format: 'markdown',
        include_blocks: true,
        confidence_scores_granularity: 'word',
      }),
    })
    if (!response.ok) throw new Error(`MISTRAL_OCR_FAILED:${response.status}:${await response.text()}`)
    return normalizeMistralOcrResponse(await response.json() as MistralOcrResponse)
  }
}

export class MockDocumentOcrProvider implements DocumentOcrProvider {
  readonly name = 'mock'
  private readonly fixtureId: string

  constructor(fixtureId: string) { this.fixtureId = fixtureId }

  async analyze() {
    const fixture = getSupplierDocumentMockFixture(this.fixtureId)
    if (!fixture) throw new Error('MOCK_FIXTURE_NOT_FOUND')
    return ocrDocumentSchema.parse(structuredClone(fixture.ocr))
  }
}

export type DocumentOcrProviderSelection = {
  provider?: string
  mockFixtureId?: string | null
  azure: AzureConfig
  mistral: MistralConfig
}

export function createDocumentOcrProvider(selection: DocumentOcrProviderSelection): DocumentOcrProvider {
  if (selection.mockFixtureId) return new MockDocumentOcrProvider(selection.mockFixtureId)
  const provider = selection.provider?.trim().toLowerCase() || 'azure'
  if (provider === 'azure') return new AzureDocumentOcrProvider(selection.azure)
  if (provider === 'mistral') return new MistralDocumentOcrProvider(selection.mistral)
  throw new ProviderConfigurationError('OCR de documentos de proveedor', [
    `SUPPLIER_DOCUMENT_OCR_PROVIDER=${provider} (usa azure o mistral)`,
  ])
}

type OpenAiConfig = { apiKey: string; model: string }

function responseOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string') return payload.output_text
  if (!Array.isArray(payload.output)) return null
  for (const item of payload.output) {
    if (!item || typeof item !== 'object' || !Array.isArray((item as { content?: unknown }).content)) continue
    for (const content of (item as { content: unknown[] }).content) {
      if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
        return (content as { text: string }).text
      }
    }
  }
  return null
}

function structuredOcr(input: { ocr: OcrDocument; documentType: 'invoice' | 'delivery_note' }) {
  return {
    requestedDocumentType: input.documentType,
    text: input.ocr.text,
    confidence: input.ocr.confidence,
    pages: input.ocr.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
      words: page.words,
      tables: page.tables,
    })),
  }
}

export class OpenAiSupplierDocumentProvider implements SupplierDocumentAiProvider {
  readonly name = 'openai-responses'
  private readonly config: OpenAiConfig

  constructor(config: OpenAiConfig) {
    if (!config.apiKey || !config.model) {
      const missing = [!config.apiKey && 'OPENAI_API_KEY', !config.model && 'OPENAI_SUPPLIER_DOCUMENT_MODEL'].filter(Boolean) as string[]
      throw new ProviderConfigurationError('OpenAI', missing)
    }
    this.config = config
  }

  async interpret(input: {
    ocr: OcrDocument
    documentType: 'invoice' | 'delivery_note'
    imageDataUrl?: string | null
    supplierCandidates: SupplierCandidate[]
  }) {
    const supplierCandidates = input.supplierCandidates.map((candidate) => ({
      supplierId: candidate.supplierId,
      name: candidate.name,
      legalName: candidate.legalName ?? null,
      taxId: candidate.taxId ?? null,
      email: candidate.email ?? null,
      phone: candidate.phone ?? null,
      address: candidate.address ?? null,
      identities: (candidate.identities ?? []).map((identity) => ({
        type: identity.type,
        value: identity.value,
      })),
    }))
    const content: Array<Record<string, unknown>> = [{
      type: 'input_text',
      text: JSON.stringify({ ...structuredOcr(input), supplierCandidates }),
    }]
    if (input.imageDataUrl) content.push({ type: 'input_image', image_url: input.imageDataUrl, detail: 'high' })
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        instructions: [
          'Interpreta un albarán o factura de proveedor a partir del OCR estructurado.',
          'En supplier identifica siempre al emisor, vendedor o proveedor que expide el documento; nunca uses el cliente, comprador, destinatario, punto de venta ni dirección de entrega.',
          'supplier.taxId debe ser exclusivamente el identificador fiscal del emisor; si no aparece o no es inequívoco devuelve null y no reutilices el NIF/CIF del destinatario.',
          'Extrae en supplier los datos que realmente aparezcan en el documento; no copies datos del candidato para completar campos ausentes.',
          'supplierCandidates son referencias existentes, no una lista obligatoria. En supplierResolution devuelve supplierId solo si existe una coincidencia razonable y deja confidence=unresolved y supplierId=null ante cualquier duda.',
          'Prioriza identificador fiscal exacto, después email o dominio, teléfono, dirección y por último nombre o razón social. Un nombre parecido por sí solo no basta para forzar una asociación.',
          'En supplierResolution.signals enumera únicamente las señales realmente observadas y en reasons resume por qué propones o descartas la asociación.',
          'No inventes líneas ni valores. Devuelve importes como números decimales.',
          'En cada línea, chargesAmount es la suma de cargos positivos y vale 0 si no hay cargos. La coherencia esperada es quantity * unitPrice - discountAmount + chargesAmount = lineTotal.',
          'Propón solo reglas declarativas compatibles con el schema, nunca código, SQL ni expresiones ejecutables.',
          'Usa lineGroup solo cuando el OCR muestre bloques multipfila repetibles: una fila principal de producto y filas auxiliares reconocibles de descuento, cargo o cierre. Todos sus aliases deben aparecer literalmente en el OCR; si no, deja lineGroup en null.',
          'Si proposedProfile no es null, sus requiredTexts, columnas y aliases deben existir en este OCR y al aplicar esas reglas deben reproducirse las mismas líneas, descuentos, cargos y netos extraídos; si no es posible, devuelve proposedProfile como null.',
          'La imagen, si existe, solo sirve para resolver OCR dudoso; prioriza siempre el OCR estructurado.',
        ].join(' '),
        input: [{ role: 'user', content }],
        text: {
          format: {
            type: 'json_schema',
            name: 'supplier_document_extraction',
            strict: true,
            schema: supplierDocumentExtractionJsonSchema,
          },
        },
      }),
    })
    if (!response.ok) throw new Error(`OPENAI_DOCUMENT_EXTRACTION_FAILED:${response.status}:${await response.text()}`)
    const payload = await response.json() as Record<string, unknown>
    const outputText = responseOutputText(payload)
    if (!outputText) throw new Error('OPENAI_DOCUMENT_EXTRACTION_EMPTY')
    return supplierDocumentExtractionSchema.parse(JSON.parse(outputText))
  }

  async proposeProfile(input: {
    ocr: OcrDocument
    documentType: 'invoice' | 'delivery_note'
    extraction: SupplierDocumentExtraction
  }) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        instructions: [
          'Genera exclusivamente un perfil declarativo reutilizable para interpretar documentos con el mismo diseño que este OCR.',
          'Las columnas description y quantity deben aparecer exactamente una vez y tener required=true.',
          'Cada field debe aparecer como máximo una vez. Los headerAliases deben ser textos reales de una misma fila de cabecera del OCR, nunca valores de productos.',
          'Usa requiredTexts estables del emisor y del diseño; no uses número, fecha, cliente, destinatario ni importes de este documento.',
          'Las reglas deben localizar la tabla de productos y reproducir las líneas objetivo. Las filas auxiliares de descuentos, impuestos, subtotales o envases no son productos.',
          'Incluye lineGroup únicamente si el OCR contiene bloques multipfila repetibles. Copia endAliases, discountAliases y chargeAliases de textos que aparezcan literalmente en las filas OCR; no inventes aliases.',
          'Cuando una fila final contiene el neto del producto, usa netTotalFromEndRow=true. Ajusta maxContinuationRows al bloque observado sin abarcar el producto siguiente.',
          'El perfil debe reproducir cantidad, descripción, descuento, cargos y total neto, cumpliendo quantity * unitPrice - discountAmount + chargesAmount = lineTotal.',
          'No devuelvas código, SQL ni expresiones ejecutables.',
        ].join(' '),
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: JSON.stringify({
              ocr: structuredOcr(input),
              targetExtraction: { document: input.extraction.document, lines: input.extraction.lines },
            }),
          }],
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'supplier_document_profile',
            strict: true,
            schema: supplierProfileRulesJsonSchema,
          },
        },
      }),
    })
    if (!response.ok) throw new Error(`OPENAI_PROFILE_GENERATION_FAILED:${response.status}:${await response.text()}`)
    const payload = await response.json() as Record<string, unknown>
    const outputText = responseOutputText(payload)
    if (!outputText) throw new Error('OPENAI_PROFILE_GENERATION_EMPTY')
    return supplierProfileRulesSchema.parse(JSON.parse(outputText))
  }
}

export class MockSupplierDocumentAiProvider implements SupplierDocumentAiProvider {
  readonly name = 'mock'
  private readonly fixtureId: string

  constructor(fixtureId: string) { this.fixtureId = fixtureId }

  async interpret() {
    const fixture = getSupplierDocumentMockFixture(this.fixtureId)
    if (!fixture) throw new Error('MOCK_FIXTURE_NOT_FOUND')
    return supplierDocumentExtractionSchema.parse(structuredClone(fixture.extraction))
  }

  async proposeProfile() {
    const fixture = getSupplierDocumentMockFixture(this.fixtureId)
    if (!fixture?.extraction.proposedProfile) throw new Error('MOCK_PROFILE_NOT_FOUND')
    return supplierProfileRulesSchema.parse(structuredClone(fixture.extraction.proposedProfile))
  }
}
