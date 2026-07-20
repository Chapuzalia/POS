export type PrintAgentErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'ORIGIN_NOT_ALLOWED' | 'PRINTER_NOT_CONFIGURED'
  | 'PRINTER_NOT_FOUND' | 'PRINTER_CONNECTION_TIMEOUT' | 'PRINTER_CONNECTION_REFUSED'
  | 'PRINT_FAILED' | 'PRINT_STATUS_UNKNOWN' | 'DISCOVERY_FAILED' | 'TLS_CONFIGURATION_ERROR'
  | 'CERTIFICATE_EXPIRED' | 'CASH_DRAWER_FAILED' | 'DUPLICATE_REQUEST' | 'NETWORK_ERROR'
  | 'TIMEOUT' | 'ABORTED' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'CONFIGURATION_ERROR'

const messages: Partial<Record<PrintAgentErrorCode, string>> = {
  INVALID_REQUEST: 'Los datos enviados al servidor de impresion no son validos.',
  UNAUTHORIZED: 'El token del servidor de impresion no es valido.',
  ORIGIN_NOT_ALLOWED: 'El servidor de impresion no permite peticiones desde este TPV.',
  PRINTER_NOT_CONFIGURED: 'No hay ninguna impresora seleccionada.',
  PRINTER_NOT_FOUND: 'No se ha encontrado la impresora configurada.',
  PRINTER_CONNECTION_TIMEOUT: 'La impresora no ha respondido a tiempo.',
  PRINTER_CONNECTION_REFUSED: 'La impresora ha rechazado la conexion.',
  PRINT_FAILED: 'No se ha podido imprimir el ticket.',
  PRINT_STATUS_UNKNOWN: 'No se puede confirmar si el ticket se imprimio. Comprueba la impresora antes de volver a intentarlo.',
  DISCOVERY_FAILED: 'No se han podido descubrir impresoras.',
  TLS_CONFIGURATION_ERROR: 'La configuracion HTTPS del agente no es valida.',
  CERTIFICATE_EXPIRED: 'El certificado HTTPS del servidor de impresion ha caducado.',
  CASH_DRAWER_FAILED: 'No se ha podido abrir el cajon.',
  DUPLICATE_REQUEST: 'El servidor ya habia recibido esta operacion.',
  NETWORK_ERROR: 'No se ha podido conectar con el servidor de impresion.',
  TIMEOUT: 'El servidor de impresion no ha respondido a tiempo.',
  ABORTED: 'La operacion de impresion se ha cancelado.',
  INVALID_RESPONSE: 'El servidor de impresion ha devuelto una respuesta no valida.',
  CONFIGURATION_ERROR: 'La configuracion del servidor de impresion no es valida.',
}

export class PrintAgentError extends Error {
  readonly code: PrintAgentErrorCode
  readonly status?: number
  readonly details?: unknown
  override readonly cause?: unknown

  constructor(input: { code: PrintAgentErrorCode; message?: string; status?: number; details?: unknown; cause?: unknown }) {
    super(input.message || messages[input.code] || 'Error del servidor de impresion.')
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

