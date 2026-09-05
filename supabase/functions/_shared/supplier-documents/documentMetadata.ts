import type { OcrDocument, SupplierProfileRules } from './core.ts'

export type MetadataField = 'date' | 'number'
export type MetadataSource = 'profile' | 'generic' | 'ai' | 'manual'
export type MetadataEvidence = {
  value: string | null
  source: MetadataSource
  evidence: string | null
  labelCandidate: string | null
  confidence: number
  userModified: boolean
  ambiguous: boolean
  profileLabel: string | null
  profileFailed: boolean
}
export type DocumentMetadata = Record<MetadataField, MetadataEvidence>
type Candidate = { value: string; evidence: string; labelCandidate: string }
const fields: MetadataField[] = ['date', 'number']
const datePattern = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\b/g
const excludedLabel = /\b(vencimiento|entrega|pedido|pago|caducidad|cliente|cif|nif|vat|telefono|iban|total|importe|referencia)\b/i

export function normalizeMetadataLabel(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim()
}

export function normalizeMetadataValue(field: MetadataField, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (field === 'number') return value.trim().length <= 80 ? value.trim() : null
  const match = value.trim().match(/^(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}))$/)
  if (!match) return null
  const year = Number(match[1] ?? match[6]), month = Number(match[2] ?? match[5]), day = Number(match[3] ?? match[4])
  const date = new Date(Date.UTC(year, month - 1, day))
  return year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null
}

// Aggregate text and page text may repeat the same evidence. Count a pair once,
// not once per OCR representation. Words alone never establish label proximity.
export function metadataOcrTexts(ocr: OcrDocument): string[] {
  return [...new Set([ocr.text, ...ocr.pages.map((page) => page.text),
    ...ocr.pages.flatMap((page) => page.tables.flatMap((table) => {
      const rows = new Map<number, typeof table.cells>()
      for (const cell of table.cells) rows.set(cell.rowIndex, [...(rows.get(cell.rowIndex) ?? []), cell])
      return [...rows.values()].map((row) => row.sort((a, b) => a.columnIndex - b.columnIndex).map((cell) => cell.text).join(' | '))
    })),
  ].filter(Boolean))]
}

function cleanLabel(prefix: string): string | null {
  const label = prefix.trim().replace(/^[|:#\s-]+|[|:#\s-]+$/g, '').trim()
  return label.length >= 2 && label.length <= 80 && /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(label)
    && !/\d/.test(label) && !excludedLabel.test(normalizeMetadataLabel(label)) ? label : null
}

function candidatesFor(ocr: OcrDocument, field: MetadataField, label?: string | null): Candidate[] {
  const candidates: Candidate[] = []
  for (const text of metadataOcrTexts(ocr)) {
    const lines = text.split('\n')
    const adjacent = lines.flatMap((line, index) => cleanLabel(line)
      && /^\s*(?=[A-Za-z0-9/_.-]*\d)[A-Za-z0-9/_.-]+(?:\s|$|\|)/.test(lines[index + 1] ?? '')
      ? [`${line}\n${lines[index + 1]}`] : [])
    for (const line of [...lines, ...adjacent]) {
      if (line.length > 500) continue
      // Markdown/table cell separators are structural, not parts of labels.
      const segments = line.split(/\s*\|\s*/)
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index].trim()
        const source = segments[index + 1] ? `${segment} | ${segments[index + 1].trim()}` : segment
        const pattern = field === 'date' ? new RegExp(datePattern) : /\b(?=[A-Za-z0-9/_.-]*\d)[A-Za-z0-9]+(?:[/_.-][A-Za-z0-9]+)*\b/g
        for (const match of source.matchAll(pattern)) {
          const value = normalizeMetadataValue(field, match[0])
          if (!value || (field === 'number' && normalizeMetadataValue('date', match[0]))) continue
          const prefix = source.slice(0, match.index).replace(/\|\s*$/, '')
          const candidateLabel = cleanLabel(prefix)
          if (!candidateLabel) continue
          if (label) {
            if (normalizeMetadataLabel(candidateLabel) !== normalizeMetadataLabel(label)) continue
          } else if (field === 'number' && !/\b(factura|albaran|documento|numero|num)\b|n[º°o.]\s/i.test(normalizeMetadataLabel(candidateLabel))
            && !/n[º°.]|\bnro\b/i.test(candidateLabel)) continue
          const evidence = line.trim()
          candidates.push({ value: match[0], evidence, labelCandidate: candidateLabel })
        }
      }
    }
  }
  return [...new Map(candidates.map((candidate) => [
    `${normalizeMetadataLabel(candidate.labelCandidate)}:${normalizeMetadataValue(field, candidate.value)}`, candidate,
  ])).values()]
}

function emptyEvidence(profileLabel: string | null): MetadataEvidence {
  return { value: null, source: 'generic', evidence: null, labelCandidate: null, confidence: 0,
    userModified: false, ambiguous: false, profileLabel, profileFailed: true }
}

export function extractProfileMetadata(ocr: OcrDocument, rules: Pick<SupplierProfileRules, 'documentDateLabel' | 'documentNumberLabel'> | null): DocumentMetadata {
  return Object.fromEntries(fields.map((field) => {
    const label = rules?.[field === 'date' ? 'documentDateLabel' : 'documentNumberLabel'] || null
    const candidates = label ? candidatesFor(ocr, field, label) : []
    const evidence = emptyEvidence(label)
    if (candidates.length === 1) Object.assign(evidence, candidates[0], { source: 'profile', confidence: 1, profileFailed: false })
    else evidence.ambiguous = candidates.length > 1
    return [field, evidence]
  })) as DocumentMetadata
}

export function extractGenericDocumentMetadata(ocr: OcrDocument, rules: Pick<SupplierProfileRules, 'documentDateLabel' | 'documentNumberLabel'> | null = null) {
  const metadata = extractProfileMetadata(ocr, rules)
  const candidates = Object.fromEntries(fields.map((field) => [field, candidatesFor(ocr, field)])) as Record<MetadataField, Candidate[]>
  for (const field of fields) {
    if (metadata[field].value) continue
    const found = candidates[field]
    if (found.length === 1) Object.assign(metadata[field], found[0], { source: 'generic', confidence: 0.95, ambiguous: false })
    else metadata[field].ambiguous ||= found.length > 1
  }
  return { metadata, candidates }
}

export function groundAiDocumentMetadata(ocr: OcrDocument, input: unknown, field: MetadataField): Candidate | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Record<string, unknown>
  if (typeof candidate.evidence !== 'string' || typeof candidate.labelCandidate !== 'string') return null
  const label = cleanLabel(candidate.labelCandidate)
  const value = normalizeMetadataValue(field, candidate.value)
  if (!label || !value || candidate.evidence.length > 500) return null
  if (!metadataOcrTexts(ocr).some((text) => text.includes(candidate.evidence as string))) return null
  // Re-derive the pair from OCR; a real citation that does not support the value
  // or an invented label is not evidence. A repeated label with different values
  // remains ambiguous, even when the model picks one of them.
  const matches = candidatesFor(ocr, field, label)
  if (matches.length !== 1 || normalizeMetadataValue(field, matches[0].value) !== value
    || !candidate.evidence.includes(matches[0].value) || !candidate.evidence.includes(label)) return null
  return { ...matches[0], evidence: candidate.evidence }
}

export async function resolveDocumentMetadata(input: {
  ocr: OcrDocument
  rules: Pick<SupplierProfileRules, 'documentDateLabel' | 'documentNumberLabel'> | null
  extract?: (input: { ocr: OcrDocument; fields: MetadataField[] }) => Promise<unknown>
}) {
  const result = extractGenericDocumentMetadata(input.ocr, input.rules)
  const unresolved = fields.filter((field) => !result.metadata[field].value && result.metadata[field].ambiguous)
  let aiError = false
  if (unresolved.length && input.extract) {
    try {
      const proposed = await input.extract({ ocr: input.ocr, fields: unresolved }) as Record<string, unknown>
      for (const field of unresolved) {
        const grounded = groundAiDocumentMetadata(input.ocr, proposed?.[field], field)
        if (grounded) Object.assign(result.metadata[field], grounded, { source: 'ai', confidence: 0.8, ambiguous: false })
      }
    } catch {
      // Metadata failure cannot turn successful deterministic lines into an error.
      aiError = true
    }
  }
  return { ...result, aiError }
}

export const documentMetadataJsonSchema = {
  type: 'object', additionalProperties: false, required: fields,
  properties: Object.fromEntries(fields.map((field) => [field, {
    type: ['object', 'null'], additionalProperties: false,
    required: ['value', 'evidence', 'labelCandidate', 'confidence'],
    properties: { value: { type: ['string', 'null'] }, evidence: { type: ['string', 'null'] },
      labelCandidate: { type: ['string', 'null'] }, confidence: { type: 'number' } },
  }])),
}
