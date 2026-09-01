import {
  ocrDocumentSchema,
  supplierDocumentExtractionJsonSchema,
  supplierDocumentExtractionSchema,
  type OcrDocument,
  type SupplierDocumentExtraction,
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
  }): Promise<SupplierDocumentExtraction>
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

type AzureConfig = {
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
  readonly name = 'azure-document-intelligence'
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

  async interpret(input: { ocr: OcrDocument; documentType: 'invoice' | 'delivery_note'; imageDataUrl?: string | null }) {
    const structuredOcr = JSON.stringify({
      requestedDocumentType: input.documentType,
      text: input.ocr.text,
      confidence: input.ocr.confidence,
      pages: input.ocr.pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: page.text,
        words: page.words,
        tables: page.tables,
      })),
    })
    const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: structuredOcr }]
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
          'No inventes líneas ni valores. Devuelve importes como números decimales.',
          'Propón solo reglas declarativas compatibles con el schema, nunca código, SQL ni expresiones ejecutables.',
          'Si proposedProfile no es null, sus requiredTexts y columnas deben existir en este OCR y al aplicar esas reglas deben reproducirse las mismas líneas extraídas; si no es posible, devuelve proposedProfile como null.',
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
}
