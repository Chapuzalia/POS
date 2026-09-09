import {
  ocrDocumentSchema, supplierDocumentExtractionSchema, supplierProfileRulesSchema,
  profileFingerprint, inspectParserTables, runDeterministicParser, validateExtractionMath,
  type OcrDocument, type SupplierDocumentExtraction, type SupplierProfileRules, type ParserExecutionTrace, type MathValidation,
} from './core.ts'
import { extractProfileMetadata, groundAiDocumentMetadata, normalizeMetadataValue } from './documentMetadata.ts'

import { validateOcrSanity } from './ocrQuality.ts'

type Row = Record<string, any>
export type ParserProfile = { id: string; status: string; rules_json: unknown }
export type ParserDiagnosis = {
  version: 1; profileId: string; profileStatus: string; rules: SupplierProfileRules | null
  classification: 'success' | 'applicable_parser_failed' | 'layout_incompatible' | 'ocr_insufficient' | 'invalid_profile' | 'profile_not_executable' | 'diagnostic_error'
  layoutMatch: boolean; layoutScore: number; plausible: boolean; repairEligible: boolean
  failedFields: Array<'lines' | 'date' | 'number'>; failures: string[]
  failureDetails: Array<{ stage: string; code: string; message: string; issues?: Array<{ path: string; code: string; message: string }> }>
  fingerprint: ReturnType<typeof profileFingerprint> | null
  ocrQuality: ReturnType<typeof validateOcrSanity> | null
  execution: ParserExecutionTrace
  extractedLineCount: number
  math: (MathValidation & { source: 'parsed' | 'partial'; lines: Array<{ index: number; expected: number | null; actual: number | null; difference: number | null; tolerance: number | null }> }) | null
  metadata: ReturnType<typeof extractProfileMetadata> | null
  extraction: SupplierDocumentExtraction | null
}
export type ParserRepairInput = {
  ocr: OcrDocument; documentType: 'invoice' | 'delivery_note'; diagnosis: ParserDiagnosis
  availableExtraction: SupplierDocumentExtraction | null; correctedExtraction?: SupplierDocumentExtraction | null
}
export type ParserRepairProposal = {
  decision: 'repair' | 'new_layout' | 'no_change'; reason: string; evidence: string[]
  sourceProfileId: string; parentProfileId: string | null; rules: SupplierProfileRules | null
  changedFields: string[]
}
const repairFields = ['requiredTexts', 'optionalTexts', 'tableStartText', 'tableEndText', 'decimalSeparator',
  'thousandsSeparator', 'documentNumberLabel', 'documentDateLabel', 'lineGroup', 'columns', 'normalizations'] as const
export const parserRepairJsonSchema = {
  type: 'object', additionalProperties: false, required: ['decision', 'reason', 'evidence', 'changes', 'newRulesJson'],
  properties: {
    decision: { type: 'string', enum: ['repair', 'new_layout', 'no_change'] }, reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['field', 'valueJson'], properties: { field: { type: 'string', enum: repairFields }, valueJson: { type: 'string' } } } },
    newRulesJson: { type: ['string', 'null'] },
  },
}

export function diagnoseParser(profile: ParserProfile, ocrInput: OcrDocument, documentType: 'invoice' | 'delivery_note',
  target?: SupplierDocumentExtraction | null,
  options: { allowCandidate?: boolean } = {}): ParserDiagnosis {
  const result: ParserDiagnosis = { version: 1, profileId: profile.id, profileStatus: profile.status, rules: null,
    classification: 'invalid_profile', layoutMatch: false, layoutScore: 0, plausible: false, repairEligible: false,
    failedFields: [], failures: [], failureDetails: [], fingerprint: null, ocrQuality: null,
    execution: { headers: [], headerCount: 0, headersTruncated: false, tableCount: 0, partialLines: [] },
    extractedLineCount: 0, math: null, metadata: null, extraction: null }
  const fail = (stage: string, code: string, message = code) => {
    result.failures.push(code)
    result.failureDetails.push({ stage, code, message })
  }
  const capture = (stage: string, code: string, error: unknown) => {
    fail(stage, code, error instanceof Error ? error.message.slice(0, 500) : code)
    if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
      result.failureDetails[result.failureDetails.length - 1].issues = error.issues.map((issue) => ({
        path: Array.isArray(issue.path) ? issue.path.map(String).join('.') : '', code: String(issue.code), message: String(issue.message).slice(0, 160),
      }))
    }
  }
  try {
    if (!['verified', 'active'].includes(profile.status)
      && !(options.allowCandidate && profile.status === 'candidate')) {
      result.classification = 'profile_not_executable'
      fail('profile', 'PROFILE_NOT_EXECUTABLE')
      return result
    }
    const parsedRules = supplierProfileRulesSchema.safeParse(profile.rules_json)
    if (!parsedRules.success) { capture('profile', 'PROFILE_RULES_INVALID', parsedRules.error); return result }
    const rules = result.rules = parsedRules.data
    const parsedOcr = ocrDocumentSchema.safeParse(ocrInput)
    if (!parsedOcr.success) {
      result.classification = 'ocr_insufficient'
      capture('ocr', 'OCR_SCHEMA_INVALID', parsedOcr.error)
      return result
    }
    const ocr = parsedOcr.data
    result.ocrQuality = validateOcrSanity(ocr)
    result.fingerprint = profileFingerprint(rules, ocr)
    result.layoutMatch = !result.fingerprint.missingRequiredTexts.length
    result.execution = inspectParserTables(ocr, rules)
    const tableHasContent = ocr.pages.some((page) => page.tables.some((table) => table.cells.some((cell) => cell.text.trim())))
    if (!result.ocrQuality.valid || !tableHasContent) {
      result.classification = 'ocr_insufficient'
      for (const reason of result.ocrQuality.reasons) fail('ocr', 'OCR_SANITY_FAILED', reason)
      if (!tableHasContent) fail('ocr', 'OCR_TABLE_STRUCTURE_MISSING')
      return result
    }
    const fingerprintScore = result.fingerprint.requiredTexts.filter((entry) => entry.found).length / rules.requiredTexts.length
    const headerScore = Math.max(0, ...result.execution.headers.map((header) => {
      const columns = header.columns.filter((column) => column.aliases.length)
      return columns.length ? columns.filter((column) => column.index !== null).length / columns.length : 0
    }))
    result.layoutScore = (fingerprintScore + headerScore) / 2
    result.plausible = result.layoutMatch || (fingerprintScore >= 0.5 && headerScore >= 0.5)
      || (rules.columns.filter((column) => column.headerAliases.length).length >= 3 && headerScore >= 0.75)
    if (!result.layoutMatch) fail('fingerprint', 'PROFILE_FINGERPRINT_MISMATCH')
    try {
      result.extraction = runDeterministicParser(rules, ocr, { documentType, supplierName: null }, result.execution)
    } catch (error) {
      const code = error instanceof Error && /^PROFILE_[A-Z_]+$/.test(error.message) ? error.message : 'PARSER_EXECUTION_FAILED'
      if (!result.failures.includes(code)) capture('lines', code, error)
    }
    const lines = result.extraction?.lines ?? result.execution.partialLines
    result.extractedLineCount = lines.length
    if (lines.length) {
      const mathInput = result.extraction ?? { document: { type: documentType, number: null, date: null, total: null },
        supplier: { name: null, legalName: null, taxId: null, email: null, phone: null, address: null },
        supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
        lines, proposedProfile: null, confidence: ocr.confidence }
      const math = validateExtractionMath(mathInput)
      result.math = { ...math, source: result.extraction ? 'parsed' : 'partial', lines: lines.map((line, index) => {
        const expected = line.unitPrice === null ? null : line.quantity * line.unitPrice - line.discountAmount + line.chargesAmount
        return { index, expected, actual: line.lineTotal,
          difference: expected === null || line.lineTotal === null ? null : expected - line.lineTotal,
          tolerance: line.lineTotal === null ? null : Math.max(0.02, Math.abs(line.lineTotal) * 0.03) }
      }) }
      if (!math.coherent) fail('math', 'LINE_MATH_MISMATCH')
      if (lines.some((line) => line.unitPrice === null || line.lineTotal === null)) fail('lines', 'LINE_AMOUNTS_MISSING')
    }
    if (target && result.extraction) {
      const comparable = (items: SupplierDocumentExtraction['lines']) => items.map((line) => [line.supplierReference,
        line.description, line.barcode, line.quantity, line.purchaseUnit, line.unitPrice, line.discountAmount,
        line.chargesAmount, line.lineTotal, line.taxRate])
      if (JSON.stringify(comparable(lines)) !== JSON.stringify(comparable(target.lines))) fail('lines', 'LINE_OUTPUT_MISMATCH')
    }
    if (result.execution.headers.some((header) => header.selected && header.rejectedRows.some((row) => row.reason.startsWith('LINE_SCHEMA_INVALID')))) {
      fail('lines', 'LINE_ROWS_REJECTED')
    }
    if (result.failures.length) result.failedFields.push('lines')
    result.metadata = extractProfileMetadata(ocr, rules)
    for (const field of ['date', 'number'] as const) {
      const value = normalizeMetadataValue(field, result.metadata[field].value)
      if (!value || (target?.document[field] && value !== normalizeMetadataValue(field, target.document[field]))) {
        result.failedFields.push(field)
        fail('metadata', `DOCUMENT_${field.toUpperCase()}_${result.metadata[field].ambiguous ? 'AMBIGUOUS' : value ? 'MISMATCH' : 'MISSING'}`)
      }
    }
    result.classification = !result.failures.length ? 'success' : result.plausible ? 'applicable_parser_failed' : 'layout_incompatible'
    result.repairEligible = result.classification === 'applicable_parser_failed'
    return result
  } catch (error) {
    capture('diagnosis', 'PARSER_DIAGNOSTIC_FAILED', error)
    result.classification = 'diagnostic_error'
    result.repairEligible = false
    result.extractedLineCount = result.extraction?.lines.length ?? result.execution.partialLines.length
    return result
  }
}
// Validate shape, scope and literal evidence only. Candidates are never executed
// or promoted here; regression belongs to the later validation phase.
export function parseParserRepairProposal(raw: unknown, input: ParserRepairInput): ParserRepairProposal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PROFILE_REPAIR_RESPONSE_INVALID')
  const currentRules = input.diagnosis.rules
  if (!currentRules || !input.diagnosis.repairEligible) throw new Error('PROFILE_REPAIR_NOT_ELIGIBLE')
  const data = raw as Row
  if (!['repair', 'new_layout', 'no_change'].includes(data.decision) || typeof data.reason !== 'string'
    || !Array.isArray(data.changes) || !Array.isArray(data.evidence)) throw new Error('PROFILE_REPAIR_RESPONSE_INVALID')
  const text = [input.ocr.text, ...input.ocr.pages.flatMap((page) => [page.text,
    ...page.tables.flatMap((table) => table.cells.map((cell) => cell.text))])].join('\n')
  if (data.evidence.some((quote: unknown) => typeof quote !== 'string' || !quote.trim() || !text.includes(quote))) throw new Error('PROFILE_REPAIR_EVIDENCE_INVALID')
  const base = { decision: data.decision, reason: data.reason, evidence: data.evidence,
    sourceProfileId: input.diagnosis.profileId, parentProfileId: null, rules: null, changedFields: [] } as ParserRepairProposal
  if (data.decision === 'no_change') {
    if (data.changes.length || data.newRulesJson != null) throw new Error('PROFILE_REPAIR_RESPONSE_INVALID')
    return base
  }
  if (!data.evidence.length) throw new Error('PROFILE_REPAIR_EVIDENCE_REQUIRED')
  const metadataOnly = !input.diagnosis.failedFields.includes('lines') && input.diagnosis.layoutMatch
  if (data.decision === 'new_layout') {
    if (metadataOnly || data.changes.length || typeof data.newRulesJson !== 'string') throw new Error('PROFILE_REPAIR_SCOPE_INVALID')
    const rules = supplierProfileRulesSchema.parse(JSON.parse(data.newRulesJson))
    if (JSON.stringify(rules) === JSON.stringify(currentRules)) throw new Error('PROFILE_REPAIR_NO_CHANGE')
    return { ...base, rules }
  }
  if (data.newRulesJson != null || !data.changes.length || data.changes.length > repairFields.length) throw new Error('PROFILE_REPAIR_RESPONSE_INVALID')
  const allowed: readonly string[] = metadataOnly ? input.diagnosis.failedFields.map((field) =>
    field === 'date' ? 'documentDateLabel' : 'documentNumberLabel') : repairFields
  const changes: Record<string, unknown> = {}
  for (const change of data.changes) {
    if (!change || !allowed.includes(change.field) || typeof change.valueJson !== 'string' || change.field in changes) throw new Error('PROFILE_REPAIR_SCOPE_INVALID')
    changes[change.field] = JSON.parse(change.valueJson)
  }
  const rules = supplierProfileRulesSchema.parse({ ...currentRules, ...changes })
  const changedFields = Object.keys(changes).filter((field) => JSON.stringify(rules[field as keyof SupplierProfileRules])
    !== JSON.stringify(currentRules[field as keyof SupplierProfileRules]))
  if (!changedFields.length) throw new Error('PROFILE_REPAIR_NO_CHANGE')
  for (const field of ['date', 'number'] as const) {
    const key = field === 'date' ? 'documentDateLabel' : 'documentNumberLabel'
    if (!changedFields.includes(key)) continue
    const value = (input.correctedExtraction ?? input.availableExtraction)?.document[field]
    if (!value || !data.evidence.some((quote: string) => groundAiDocumentMetadata(input.ocr,
      { value, labelCandidate: rules[key], evidence: quote }, field))) throw new Error('PROFILE_REPAIR_METADATA_NOT_GROUNDED')
  }
  return { ...base, parentProfileId: input.diagnosis.profileId, rules, changedFields }
}

export function confirmedProfileTarget(document: Row, lines: Row[], supplier: Row) {
  return supplierDocumentExtractionSchema.parse({
    document: { type: document.document_type, number: document.document_number,
      date: document.document_date, total: null },
    supplier: { name: supplier.name, legalName: supplier.legal_name, taxId: supplier.tax_id,
      email: null, phone: null, address: null },
    supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
    lines: lines.map((line) => ({
      supplierReference: line.supplier_reference, description: line.description_raw,
      barcode: line.barcode, quantity: Number(line.quantity), purchaseUnit: line.purchase_unit,
      unitPrice: line.unit_price === null ? null : Number(line.unit_price),
      discountAmount: Number(line.discount_amount ?? 0), chargesAmount: Number(line.charges_amount ?? 0),
      grossCost: line.gross_cost === null ? null : Number(line.gross_cost),
      netCost: line.net_cost === null ? null : Number(line.net_cost),
      lineTotal: line.line_total === null ? null : Number(line.line_total),
      taxRate: line.tax_rate === null ? null : Number(line.tax_rate),
      packageExpression: null, confidence: 1,
    })), proposedProfile: null, confidence: 1,
  })
}

export async function proposeConfirmedProfileRepair(input: {
  document: Row; lines: Row[]; supplier: Row; profile: ParserProfile
  onDiagnosis?: (diagnosis: ParserDiagnosis) => void
  propose: (input: ParserRepairInput) => Promise<ParserRepairProposal>
}) {
  const metadata = input.document.extraction_metadata ?? {}
  if (input.document.status !== 'confirmed' || metadata.learningExcluded === true
    || metadata.linesReparsedAt || metadata.supplierSelection?.manual === true
    || metadata.supplierSelection?.source === 'manual') throw new Error('PROFILE_REPAIR_NOT_ELIGIBLE')
  const ocr = ocrDocumentSchema.parse(input.document.ocr_snapshot)
  const target = confirmedProfileTarget(input.document, input.lines, input.supplier)
  const diagnosis = diagnoseParser(input.profile, ocr, target.document.type, target)
  input.onDiagnosis?.(diagnosis)
  if (!diagnosis.repairEligible) return {
    decision: 'no_change' as const, reason: 'PROFILE_REPAIR_NOT_APPLICABLE', evidence: [],
    sourceProfileId: input.profile.id, parentProfileId: null, rules: null, changedFields: [],
  }
  return input.propose({ ocr, documentType: target.document.type, diagnosis,
    availableExtraction: diagnosis.extraction, correctedExtraction: target })
}
