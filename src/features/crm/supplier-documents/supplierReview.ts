export const PROVISIONAL_SUPPLIER = '__provisional_supplier__'

export function supplierReviewState(document: { supplierId: string | null; extractionMetadata: Record<string, unknown> }) {
  const metadata = document.extractionMetadata
  const extraction = metadata.supplierExtraction as { groundingVersion?: number; name?: { value?: string | null; evidence?: string | null } } | undefined
  const selection = metadata.supplierSelection as { kind?: string } | undefined
  const detectedName = extraction?.groundingVersion === 1 && extraction.name?.evidence
    && typeof extraction.name.value === 'string' ? extraction.name.value : null
  const isProvisional = !document.supplierId && selection?.kind === 'provisional' && Boolean(detectedName)
  return {
    detectedName,
    isProvisional,
    hasSupplier: Boolean(document.supplierId || isProvisional),
    selectedValue: document.supplierId ?? (isProvisional ? PROVISIONAL_SUPPLIER : ''),
    canReparseLines: Boolean(document.supplierId && metadata.hasStoredOcr && metadata.linesNeedReparse),
  }
}

export function requiresLineReparseConfirmation(
  lines: Array<{ wasCorrected: boolean; referenceCostDecided?: boolean; updateReferenceCost?: boolean }>,
  hasOpenEditor = false,
) {
  return hasOpenEditor || lines.some((line) => line.wasCorrected || line.referenceCostDecided || line.updateReferenceCost)
}
