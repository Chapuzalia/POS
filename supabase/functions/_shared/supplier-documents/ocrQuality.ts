import type { OcrDocument } from './core.ts'
import type { DocumentBinaryInput, DocumentOcrProvider } from './providers.ts'

export const OCR_QUALITY_TOO_LOW = 'OCR_QUALITY_TOO_LOW'
export const OCR_QUALITY_MESSAGE = 'No hemos podido leer correctamente el documento. Haz una nueva foto con mejor iluminación, enfoque y procurando que el documento aparezca completo.'

// Conservative corruption guards, not a score of invoice/extraction correctness.
export const ocrSanityThresholds = {
  minimumAlphanumericCharacters: 20,
  minimumRepetitionCharacters: 1_000,
  minimumRepetitions: 12,
  repeatedLineCoverage: 0.80,
  minimumDiversityLines: 30,
  maximumUniqueLineRatio: 0.10,
  minimumSequenceCharacters: 1_500,
  sequenceWords: 8,
  repeatedSequenceCoverage: 0.85,
  minimumVisualDetectionObjects: 3,
  visualDetectionCoverage: 0.60,
} as const

function normalizedText(text: string) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function inspectText(text: string, pageCount = 1) {
  const normalized = normalizedText(text)
  const alphanumericCharacters = (normalized.match(/[\p{L}\p{N}]/gu) ?? []).length
  const alphanumericRatio = alphanumericCharacters / Math.max(normalized.length, 1)
  // Short numbers, separators and repeated empty table cells are not prose.
  const lines = text.split(/\r?\n/).map(normalizedText).filter((line) =>
    (line.match(/[\p{L}\p{N}]/gu) ?? []).length >= 8,
  )
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  const minimumRepetitions = Math.max(ocrSanityThresholds.minimumRepetitions, pageCount * 4)
  let repeatedCharacters = 0
  let duplicateCharacters = 0
  let maximumLineRepetitions = 0
  for (const [line, count] of counts) {
    maximumLineRepetitions = Math.max(maximumLineRepetitions, count)
    duplicateCharacters += line.length * (count - 1)
    if (count >= minimumRepetitions) repeatedCharacters += line.length * count
  }
  const repeatedLineCoverage = repeatedCharacters / Math.max(normalized.length, 1)
  const duplicateLineCoverage = duplicateCharacters / Math.max(normalized.length, 1)
  const uniqueLineRatio = counts.size / Math.max(lines.length, 1)

  // Eight-word windows also detect paragraphs/blocks repeated without newlines.
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  let maximumSequenceRepetitions = 0
  let repeatedSequenceCoverage = 0
  if (normalized.length >= ocrSanityThresholds.minimumSequenceCharacters) {
    const size = ocrSanityThresholds.sequenceWords
    const sequences = new Map<string, { count: number; next: number }>()
    for (let index = 0; index <= words.length - size; index++) {
      const key = words.slice(index, index + size).join(' ')
      const sequence = sequences.get(key) ?? { count: 0, next: 0 }
      if (index >= sequence.next) {
        sequence.count++
        sequence.next = index + size // Count non-overlapping occurrences.
      }
      sequences.set(key, sequence)
      maximumSequenceRepetitions = Math.max(maximumSequenceRepetitions, sequence.count)
    }
    const coverage = new Int32Array(words.length + 1)
    for (let index = 0; index <= words.length - size; index++) {
      const key = words.slice(index, index + size).join(' ')
      if ((sequences.get(key)?.count ?? 0) < minimumRepetitions) continue
      coverage[index]++
      coverage[index + size]--
    }
    let active = 0
    let coveredWords = 0
    for (let index = 0; index < words.length; index++) {
      active += coverage[index]
      if (active > 0) coveredWords++
    }
    repeatedSequenceCoverage = coveredWords / Math.max(words.length, 1)
  }

  // Match flat detection objects even in fenced, nested or truncated JSON. An
  // isolated brace, key or quoted JSON example in a real invoice is insufficient.
  let visualDetectionObjects = 0
  let visualDetectionCharacters = 0
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    if (/"box_2d"\s*:\s*\[/i.test(match[0]) && /"label"\s*:/i.test(match[0]) && /"caption"\s*:/i.test(match[0])) {
      visualDetectionObjects++
      visualDetectionCharacters += match[0].length
    }
  }
  const visualDetectionCoverage = visualDetectionCharacters / Math.max(text.length, 1)
  const reasons: string[] = []
  if (alphanumericCharacters < ocrSanityThresholds.minimumAlphanumericCharacters) reasons.push('empty_or_nearly_empty')
  if (normalized.length >= 100 && alphanumericRatio < 0.05) reasons.push('almost_no_alphanumeric_content')
  if (normalized.length >= ocrSanityThresholds.minimumRepetitionCharacters) {
    if (repeatedLineCoverage >= ocrSanityThresholds.repeatedLineCoverage) reasons.push('excessive_repeated_content')
    if (lines.length >= ocrSanityThresholds.minimumDiversityLines
      && uniqueLineRatio <= ocrSanityThresholds.maximumUniqueLineRatio
      && duplicateLineCoverage >= 0.80 && maximumLineRepetitions >= minimumRepetitions) reasons.push('very_low_content_diversity')
  }
  if (repeatedSequenceCoverage >= ocrSanityThresholds.repeatedSequenceCoverage) reasons.push('excessive_repeated_sequences')
  if (visualDetectionObjects >= ocrSanityThresholds.minimumVisualDetectionObjects
    && visualDetectionCoverage >= ocrSanityThresholds.visualDetectionCoverage) reasons.push('dominant_visual_detection_json')
  return {
    reasons,
    metrics: {
      characterCount: normalized.length, alphanumericCharacters, alphanumericRatio,
      meaningfulLineCount: lines.length, uniqueLineCount: counts.size, uniqueLineRatio,
      maximumLineRepetitions, repeatedLineCoverage, duplicateLineCoverage,
      wordCount: words.length, maximumSequenceRepetitions, repeatedSequenceCoverage,
      visualDetectionObjects, visualDetectionCoverage,
    },
  }
}

function pageText(page: OcrDocument['pages'][number]) {
  if (page.text.trim()) return page.text
  const blocks = page.blocks?.map((block) => block.text).join('\n') ?? ''
  if (blocks.trim()) return blocks
  const tables = page.tables.flatMap((table) => {
    const rows = new Map<number, string[]>()
    for (const cell of table.cells) rows.set(cell.rowIndex, [...(rows.get(cell.rowIndex) ?? []), cell.text])
    return [...rows.values()].map((row) => row.join(' '))
  }).join('\n')
  return tables.trim() ? tables : page.words.map((word) => word.text).join(' ')
}

export function validateOcrSanity(ocr: OcrDocument) {
  const pages = ocr.pages.map(pageText)
  // Never concatenate document.text AND page.text: they usually duplicate the
  // same representation. Page checks prevent one corrupt page being diluted.
  const document = inspectText(ocr.text.trim() ? ocr.text : pages.join('\n'), Math.max(ocr.pages.length, 1))
  const suspiciousPages = pages.flatMap((text, index) => {
    const check = inspectText(text)
    // A blank/short final page is harmless when the document itself has content.
    const reasons = check.reasons.filter((reason) => reason !== 'empty_or_nearly_empty')
    return reasons.length ? [{ pageNumber: ocr.pages[index].pageNumber, reasons, metrics: check.metrics }] : []
  })
  const reasons = [...new Set([...document.reasons, ...suspiciousPages.flatMap((page) => page.reasons)])]
  return { valid: reasons.length === 0, reasons, metrics: {
    ...document.metrics, pageCount: ocr.pages.length, confidence: ocr.confidence, suspiciousPages,
  } }
}

export type OcrAttempt = {
  provider: string
  accepted: boolean
  sanityReasons: string[]
  metrics: ReturnType<typeof validateOcrSanity>['metrics'] | null
  providerErrorCode?: string
}

export class OcrQualityError extends Error {
  readonly code = OCR_QUALITY_TOO_LOW
  readonly attempts: OcrAttempt[]
  constructor(attempts: OcrAttempt[]) {
    super(OCR_QUALITY_MESSAGE)
    this.name = 'OcrQualityError'
    this.attempts = attempts
  }
}

export function ocrAttemptMetadata(attempts: OcrAttempt[]) {
  return {
    ocrProvider: attempts.find((attempt) => attempt.accepted)?.provider ?? null,
    ocrAttempts: attempts,
    ocrFallbackUsed: attempts.some((attempt, index) => index > 0 && attempt.provider === 'azure'),
    ocrSanityVersion: 1,
  }
}

export async function analyzeOcrWithQuality(
  input: DocumentBinaryInput,
  primary: { name: string; create: () => DocumentOcrProvider },
  createAzureFallback: () => DocumentOcrProvider,
) {
  const attempts: OcrAttempt[] = []
  const attempt = async (name: string, create: () => DocumentOcrProvider) => {
    let ocr: OcrDocument
    try {
      ocr = await create().analyze(input)
    } catch (error) {
      // No raw HTTP body, stack trace or credential enters metadata or the UI.
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : error instanceof Error ? error.message.split(':')[0] : ''
      const invalidStructure = error instanceof SyntaxError
        || (error instanceof Error && error.name === 'ZodError')
        || /^MISTRAL_OCR_(EMPTY|MODEL_MISSING|PAGE_INDEX_INVALID|PAGE_TEXT_MISSING|DIMENSIONS_MISSING|CONFIDENCE_MISSING|BLOCK_INVALID)$/.test(code)
      attempts.push({ provider: name, accepted: false, metrics: null,
        sanityReasons: [invalidStructure ? 'invalid_ocr_structure' : 'ocr_provider_error'],
        providerErrorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'OCR_PROVIDER_FAILED',
      })
      if (invalidStructure) return null
      // Availability/authentication errors are not evidence of corrupt OCR and
      // must not incur an extra Azure call. A failed fallback stops here too.
      throw new OcrQualityError(attempts)
    }
    const sanity = validateOcrSanity(ocr)
    attempts.push({ provider: name, accepted: sanity.valid, sanityReasons: sanity.reasons, metrics: sanity.metrics })
    return sanity.valid ? ocr : null
  }
  const first = await attempt(primary.name, primary.create)
  if (first) return { ocr: first, attempts }
  if (primary.name === 'mistral') {
    const fallback = await attempt('azure', createAzureFallback)
    if (fallback) return { ocr: fallback, attempts }
  }
  throw new OcrQualityError(attempts)
}
