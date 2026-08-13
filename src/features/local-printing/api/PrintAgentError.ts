export type PrintAgentErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'ORIGIN_NOT_ALLOWED' | 'PRINTER_NOT_CONFIGURED'
  | 'PRINTER_NOT_FOUND' | 'PRINTER_CONNECTION_TIMEOUT' | 'PRINTER_CONNECTION_REFUSED'
  | 'PRINT_FAILED' | 'PRINT_STATUS_UNKNOWN' | 'DISCOVERY_FAILED' | 'TLS_CONFIGURATION_ERROR'
  | 'CERTIFICATE_EXPIRED' | 'CASH_DRAWER_FAILED' | 'DUPLICATE_REQUEST' | 'NETWORK_ERROR'
  | 'TIMEOUT' | 'ABORTED' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'CONFIGURATION_ERROR'

const messages: Partial<Record<PrintAgentErrorCode, string>> = {
  INVALID_REQUEST: 'Los datos enviados al servidor de impresión no son válidos.',
  UNAUTHORIZED: 'El token del servidor de impresión no es válido.',
  ORIGIN_NOT_ALLOWED: 'El servidor de impresión no permite peticiones desde este TPV.',
  PRINTER_NOT_CONFIGURED: 'No hay ninguna impresora seleccionada.',
  PRINTER_NOT_FOUND: 'No se ha encontrado la impresora configurada.',
  PRINTER_CONNECTION_TIMEOUT: 'La impresora no ha respondido a tiempo.',
  PRINTER_CONNECTION_REFUSED: 'La impresora ha rechazado la conexión.',
  PRINT_FAILED: 'No se ha podido imprimir el ticket.',
  PRINT_STATUS_UNKNOWN: 'No se puede confirmar si el ticket se imprimió. Comprueba la impresora antes de volver a intentarlo.',
  DISCOVERY_FAILED: 'No se han podido descubrir impresoras.',
  TLS_CONFIGURATION_ERROR: 'La configuración HTTPS del agente no es válida.',
  CERTIFICATE_EXPIRED: 'El certificado HTTPS del servidor de impresión ha caducado.',
  CASH_DRAWER_FAILED: 'No se ha podido abrir el cajón.',
  DUPLICATE_REQUEST: 'El servidor ya había recibido esta operación.',
  NETWORK_ERROR: 'No se ha podido conectar con el servidor de impresión.',
  TIMEOUT: 'El servidor de impresión no ha respondido a tiempo.',
  ABORTED: 'La operación de impresión se ha cancelado.',
  INVALID_RESPONSE: 'El servidor de impresión ha devuelto una respuesta no válida.',
  CONFIGURATION_ERROR: 'La configuración del servidor de impresión no es válida.',
}

export class PrintAgentError extends Error {
  readonly code: PrintAgentErrorCode
  readonly status?: number
  readonly details?: unknown
  override readonly cause?: unknown

  constructor(input: { code: PrintAgentErrorCode; message?: string; status?: number; details?: unknown; cause?: unknown }) {
    super(input.message || messages[input.code] || 'Error del servidor de impresión.')
    this.name = 'PrintAgentError'
    this.code = input.code
    this.status = input.status
    this.details = input.details
    this.cause = input.cause
  }
}

export function toPrintAgentError(error: unknown, fallback: PrintAgentErrorCode = 'NETWORK_ERROR') {
  if (error instanceof PrintAgentError) return error
  return new PrintAgentError({ code: fallback, cause: error })
}

export function getPrintAgentErrorMessage(error: unknown) {
  return toPrintAgentError(error).message
}

