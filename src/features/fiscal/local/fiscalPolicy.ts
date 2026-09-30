export type FiscalDocumentKind = 'simplified' | 'complete' | 'corrective'
export type FiscalOperation =
  | { kind: 'original'; document: 'simplified' | 'complete' }
  | { kind: 'replacement'; replacedInvoiceIds: readonly string[]; originalSaleId: string; previouslyDeclared: true; originalTotalCents: number; replacementTotalCents: number }
  | { kind: 'correction'; correctedInvoiceIds: readonly string[]; originalDocument: 'simplified' | 'complete'; aeatType: 'R1' | 'R2' | 'R3' | 'R4' | 'R5'; reason: string; method: 'difference' | 'substitution' }
  | { kind: 'annulment'; invoiceId: string; reason: string }

/** A refund is an economic operation; it never implies an AEAT annulment. */
export function classifyFiscalOperation(operation: FiscalOperation) {
  if (operation.kind === 'original') return { documentKind: operation.document, aeatType: operation.document === 'complete' ? 'F1' : 'F2' }
  if (operation.kind === 'replacement') {
    if (operation.replacedInvoiceIds.length !== 1 || !operation.originalSaleId || operation.previouslyDeclared !== true) {
      throw new Error('F3 exige exactamente una simplificada ya facturada y declarada y su venta original.')
    }
    if (!Number.isSafeInteger(operation.originalTotalCents) || operation.originalTotalCents !== operation.replacementTotalCents) {
      throw new Error('La sustitución F3 no puede modificar el importe de la venta original; requiere tratamiento fiscal separado.')
    }
    return { documentKind: 'complete' as const, aeatType: 'F3' as const, accountingDeltaCents: 0 }
  }
  if (operation.kind === 'correction') {
    if (operation.correctedInvoiceIds.length !== 1 || !operation.reason.trim()) {
      throw new Error('La rectificativa requiere un antecedente y un motivo fiscal explícito.')
    }
    if ((operation.originalDocument === 'simplified') !== (operation.aeatType === 'R5')) {
      throw new Error('R5 corresponde a rectificativa de simplificada; debe elegirse un tipo fiscal congruente.')
    }
    return { documentKind: 'corrective' as const, aeatType: operation.aeatType, method: operation.method }
  }
  if (!operation.invoiceId || !operation.reason.trim()) throw new Error('La anulación requiere factura y motivo explícitos.')
  return { documentKind: null, aeatType: null, recordKind: 'anulacion' as const }
}

/** A new exercise is a new series; the SIF chain is independent of series and sessions. */
export function fiscalSeries(input: { venueCode: string; registerCode: string; kind: FiscalDocumentKind; exercise: number; rectificative?: boolean }): string {
  const segment = (value: string) => {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z0-9]+$/.test(normalized)) throw new Error('Código fiscal de serie inválido.')
    return normalized
  }
  const venue = segment(input.venueCode)
  const register = segment(input.registerCode)
  if (!venue || !register || input.exercise < 2024 || !Number.isInteger(input.exercise)) throw new Error('Identificación de serie fiscal inválida.')
  const series = `${venue}-${register}-${input.exercise}-${input.rectificative ? 'R' : { simplified: 'S', complete: 'F', corrective: 'R' }[input.kind]}`
  if (series.length > 40) throw new Error('La serie fiscal supera el límite configurado.')
  return series
}
