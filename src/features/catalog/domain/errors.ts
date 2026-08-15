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
  | 'CATALOG_SALE_FORMAT_INVALID'
  | 'CATALOG_FORBIDDEN'
  | 'CATALOG_MENU_INCOMPLETE'
  | 'CATALOG_SELECTION_GROUP_SCOPE_INVALID'
  | 'CATALOG_NESTED_MENU'
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
  CATALOG_CLEAR_FORBIDDEN: 'CATALOG_FORBIDDEN',
  CATALOG_COMMAND_FORBIDDEN: 'CATALOG_FORBIDDEN',
  CATALOG_MENU_INCOMPLETE: 'CATALOG_MENU_INCOMPLETE',
  CATALOG_SELECTION_GROUP_SCOPE_INVALID: 'CATALOG_SELECTION_GROUP_SCOPE_INVALID',
  CATALOG_PRODUCT_NOT_FOUND: 'CATALOG_PRODUCT_NOT_FOUND',
  CATALOG_SALE_FORMAT_NOT_FOUND: 'CATALOG_SALE_FORMAT_INVALID',
  CATALOG_SALE_FORMAT_PLAN_INVALID: 'CATALOG_SALE_FORMAT_INVALID',
  CATALOG_SCOPE_MISMATCH: 'CATALOG_CROSS_VENUE',
  CATALOG_VARIANT_FORMAT_REQUIRED: 'CATALOG_SALE_FORMAT_INVALID',
  CATALOG_VARIANT_NOT_FOUND: 'CATALOG_VARIANT_NOT_FOUND',
  INSUFFICIENT_ACTIVE_CAPACITY: 'CATALOG_SELECTION_OUT_OF_BOUNDS',
  INVALID_ACTIVE_DEFAULT_VARIANT_COUNT: 'CATALOG_PRODUCT_NOT_SELLABLE',
  NESTED_MENU_NOT_ALLOWED: 'CATALOG_NESTED_MENU',
  PLACEMENT_VARIANT_PRODUCT_MISMATCH: 'CATALOG_VARIANT_PRODUCT_MISMATCH',
  VARIANT_PRODUCT_SCOPE_MISMATCH: 'CATALOG_CROSS_VENUE',
}

const postgresMessageMap: Partial<Record<string, string>> = {
  ACTIVE_ASSIGNMENT_INACTIVE_GROUP: 'Una asignación activa apunta a un grupo de catálogo inactivo.',
  ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT: 'Una asignación activa apunta a un producto inactivo.',
  CATALOG_CLEAR_FORBIDDEN: 'No tienes permisos para borrar el catálogo de este local.',
  CATALOG_COMMAND_FORBIDDEN: 'No tienes permisos para modificar este catálogo.',
  CATALOG_MENU_INCOMPLETE: 'Completa al menos un curso obligatorio con opciones disponibles antes de publicar el menú.',
  CATALOG_SELECTION_GROUP_SCOPE_INVALID: 'Los cursos de un menú solo pueden configurarse desde el propio menú; los mixers se asignan únicamente a productos estándar.',
  CATALOG_PRODUCT_NOT_FOUND: 'No se ha encontrado uno de los productos que se intentaba actualizar.',
  CATALOG_SALE_FORMAT_NOT_FOUND: 'No se ha encontrado uno de los formatos de venta de la importación.',
  CATALOG_SALE_FORMAT_PLAN_INVALID: 'Los formatos de venta preparados para la importación no son válidos.',
  CATALOG_SCOPE_MISMATCH: 'La operación contiene datos de otro local.',
  CATALOG_VARIANT_FORMAT_REQUIRED: 'El lote contiene variantes sin una relación de formato válida.',
  CATALOG_VARIANT_NOT_FOUND: 'No se ha encontrado una de las variantes que se intentaba actualizar.',
  INSUFFICIENT_ACTIVE_CAPACITY: 'Una selección activa no admite la cantidad mínima configurada.',
  INVALID_ACTIVE_DEFAULT_VARIANT_COUNT: 'Un producto debe tener exactamente una variante predeterminada activa.',
  NESTED_MENU_NOT_ALLOWED: 'Un menú no puede utilizar otro menú como plato. Selecciona un producto estándar.',
  PLACEMENT_VARIANT_PRODUCT_MISMATCH: 'Una aparición apunta a una variante de otro producto.',
  VARIANT_PRODUCT_SCOPE_MISMATCH: 'Una variante apunta a un producto de otro local.',
}

export function toCatalogDomainError(error: unknown, fallback = 'No se pudo completar la operación de catálogo.') {
  if (error instanceof CatalogDomainError) return error
  const source = error as { code?: string; message?: string; details?: string; hint?: string } | null
  const message = source?.message ?? fallback
  const matched = Object.entries(postgresCodeMap).find(([token]) => source?.code === token || message.includes(token))
  const readableMessage = matched
    ? postgresMessageMap[matched[0]] ?? `${fallback} Detalle: ${matched[0]}`
    : message && message !== fallback
      ? `${fallback} Detalle: ${message}`
      : fallback
  return new CatalogDomainError(matched?.[1] ?? 'CATALOG_UNKNOWN', readableMessage, {
    databaseCode: source?.code ?? null,
    databaseMessage: message,
    databaseDetails: source?.details ?? null,
    databaseHint: source?.hint ?? null,
  }, error instanceof Error ? { cause: error } : undefined)
}
