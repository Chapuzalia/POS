import * as base from './contract-base.mjs'

export const { CATALOG_FORMAT, CATALOG_SCHEMA_VERSION, COLLECTIONS, catalogExportSchema, formatValidation } = base

export function validateCatalog(document) {
  const validation = base.validateCatalog(document)
  if (!document?.catalog || !validation.issues) return validation
  const issues = [...validation.issues]
  const tenantId = document.metadata?.origin?.venue?.trace?.tenantId ?? document.metadata?.origin?.tenant?.trace?.originalId
  const venueId = document.metadata?.origin?.venue?.trace?.originalId
  for (const [name, rows] of Object.entries(document.catalog)) {
    if (!Array.isArray(rows)) continue
    rows.forEach((item, index) => {
      if (tenantId && item?.trace?.tenantId && item.trace.tenantId !== tenantId) issues.push({ level: 'ERROR', code: 'CROSS_TENANT_RELATION', path: `$.catalog.${name}[${index}].trace.tenantId`, message: 'El registro pertenece a otro tenant.' })
      if (venueId && item?.trace?.venueId && item.trace.venueId !== venueId) issues.push({ level: 'ERROR', code: 'CROSS_VENUE_RELATION', path: `$.catalog.${name}[${index}].trace.venueId`, message: 'El registro pertenece a otro local.' })
    })
  }
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 }
  issues.forEach((item) => { counts[item.level] += 1 })
  return { valid: counts.ERROR === 0, counts, issues }
}

export function assertValidCatalog(document) {
  const validation = validateCatalog(document)
  if (!validation.valid) {
    const error = new Error(`Catálogo inválido: ${validation.counts.ERROR} error(es)`)
    error.validation = validation
    throw error
  }
  return validation
}
