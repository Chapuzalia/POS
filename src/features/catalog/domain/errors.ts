export type CatalogErrorCode =
  | 'CATALOG_PRODUCT_NOT_FOUND'
  | 'CATALOG_VARIANT_NOT_FOUND'
  | 'CATALOG_VARIANT_PRODUCT_MISMATCH'
  | 'CATALOG_PLACEMENT_INVALID'
  | 'CATALOG_INCONSISTENT'
  | 'CATALOG_GROUP_INVALID'
  | 'CATALOG_SELECTION_OUT_OF_BOUNDS'
  | 'CATALOG_NEGATIVE_FINAL_PRICE'
  | 'CATALOG_CROSS_VENUE'
  | 'CATALOG_PRODUCT_NOT_SELLABLE'
  | 'CATALOG_REFERENCED_ENTITY'
  | 'CATALOG_FORBIDDEN'
  | 'CATALOG_UNKNOWN'

export class CatalogDomainError extends Error {
  readonly code: CatalogErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: CatalogErrorCode, message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CatalogDomainError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

const postgresCodeMap: Record<string, CatalogErrorCode> = {
  ACTIVE_ASSIGNMENT_INACTIVE_GROUP: 'CATALOG_GROUP_INVALID',
  ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT: 'CATALOG_PRODUCT_NOT_SELLABLE',
  CATALOG_COMMAND_FORBIDDEN: 'CATALOG_FORBIDDEN',
  CATALOG_SCOPE_MISMATCH: 'CATALOG_CROSS_VENUE',
  INSUFFICIENT_ACTIVE_CAPACITY: 'CATALOG_SELECTION_OUT_OF_BOUNDS',
  INVALID_ACTIVE_DEFAULT_VARIANT_COUNT: 'CATALOG_PRODUCT_NOT_SELLABLE',
  PLACEMENT_VARIANT_PRODUCT_MISMATCH: 'CATALOG_VARIANT_PRODUCT_MISMATCH',
  VARIANT_PRODUCT_SCOPE_MISMATCH: 'CATALOG_CROSS_VENUE',
}

export function toCatalogDomainError(error: unknown, fallback = 'No se pudo completar la operación de catálogo.') {
  if (error instanceof CatalogDomainError) return error
  const source = error as { code?: string; message?: string; details?: string; hint?: string } | null
  const message = source?.message ?? fallback
  const matched = Object.entries(postgresCodeMap).find(([token]) => message.includes(token))
  return new CatalogDomainError(matched?.[1] ?? 'CATALOG_UNKNOWN', fallback, {
    databaseCode: source?.code ?? null,
    databaseMessage: message,
    databaseDetails: source?.details ?? null,
    databaseHint: source?.hint ?? null,
  }, error instanceof Error ? { cause: error } : undefined)
}
