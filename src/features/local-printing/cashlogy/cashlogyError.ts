import { PrintAgentError } from '../api/PrintAgentError.ts'

export type CashlogyErrorCode =
  | 'CASHLOGY_BAD_DATA' | 'CASHLOGY_DISABLED' | 'CASHLOGY_NOT_CONFIGURED' | 'CASHLOGY_CONNECTOR_UNREACHABLE'
  | 'CASHLOGY_CONNECTION_TIMEOUT' | 'CASHLOGY_INITIALIZATION_TIMEOUT' | 'CASHLOGY_NOT_INITIALIZED'
  | 'CASHLOGY_BUSY' | 'CASHLOGY_OPERATION_CANCELLED' | 'CASHLOGY_CONNECTION_LOST'
  | 'CASHLOGY_STATUS_UNKNOWN' | 'CASHLOGY_RECONCILIATION_MISMATCH'
  | 'CASHLOGY_CANCEL_ON_CONNECTOR_SCREEN' | 'CASHLOGY_NOT_READY' | 'CASHLOGY_INVALID_STATE'
  | 'CASHLOGY_NETWORK_ERROR' | 'CASHLOGY_CASH_MANAGEMENT_NOT_FOUND' | 'CASHLOGY_CASH_MANAGEMENT_NOT_ACTIVE'
  | 'CASHLOGY_OPERATION_FAILED'

const messages: Record<CashlogyErrorCode, string> = {
  CASHLOGY_BAD_DATA: 'Los datos enviados a Cashlogy no son válidos.',
  CASHLOGY_DISABLED: 'Cashlogy está deshabilitado en el servidor local.',
  CASHLOGY_NOT_CONFIGURED: 'Cashlogy no está configurado en el servidor local.',
  CASHLOGY_CONNECTOR_UNREACHABLE: 'No se puede acceder a CashlogyConnector.',
  CASHLOGY_CONNECTION_TIMEOUT: 'Cashlogy no ha respondido a tiempo.',
  CASHLOGY_INITIALIZATION_TIMEOUT: 'Cashlogy no ha terminado de inicializarse.',
  CASHLOGY_NOT_INITIALIZED: 'Cashlogy todavía no está inicializado.',
  CASHLOGY_BUSY: 'Cashlogy ya está procesando otra operación.',
  CASHLOGY_OPERATION_CANCELLED: 'La operación de Cashlogy se ha cancelado.',
  CASHLOGY_CONNECTION_LOST: 'Se ha perdido la conexión con Cashlogy durante el cobro.',
  CASHLOGY_STATUS_UNKNOWN: 'Cashlogy pudo mover efectivo, pero no se puede confirmar el resultado. Revisa la máquina y la contabilidad.',
  CASHLOGY_RECONCILIATION_MISMATCH: 'Los importes de Cashlogy no cuadran. Es necesaria una revisión manual.',
  CASHLOGY_CANCEL_ON_CONNECTOR_SCREEN: 'Cancela la operación desde la pantalla de CashlogyConnector.',
  CASHLOGY_NOT_READY: 'Cashlogy está configurado, pero no está listo para iniciar un cobro.',
  CASHLOGY_INVALID_STATE: 'La operación de Cashlogy debe resolverse antes de iniciar otro cobro.',
  CASHLOGY_NETWORK_ERROR: 'No se ha podido comunicar con Cashlogy. La operación queda guardada para recuperarla.',
  CASHLOGY_CASH_MANAGEMENT_NOT_FOUND: 'No se ha encontrado la operación de efectivo guardada.',
  CASHLOGY_CASH_MANAGEMENT_NOT_ACTIVE: 'Cashlogy no tiene una admisión de efectivo que pueda cancelarse ahora.',
  CASHLOGY_OPERATION_FAILED: 'Cashlogy ha confirmado que la operación ha fallado.',
}

export class CashlogyError extends Error {
  readonly code: CashlogyErrorCode
  readonly originalCode: string | null
  readonly details?: unknown

  constructor(input: { code: CashlogyErrorCode; message?: string | null; originalCode?: string | null; details?: unknown }) {
    super(input.message || messages[input.code])
    this.name = 'CashlogyError'
    this.code = input.code
    this.originalCode = input.originalCode ?? null
    this.details = input.details
  }
}

export function toCashlogyError(error: unknown, fallback: CashlogyErrorCode = 'CASHLOGY_NETWORK_ERROR') {
  if (error instanceof CashlogyError) return error
  const details = error instanceof PrintAgentError ? error.details : undefined
  const remote = details && typeof details === 'object' && 'error' in details
    ? (details as { error?: { code?: unknown; message?: unknown; originalCode?: unknown } }).error
    : null
  const code = typeof remote?.code === 'string' && remote.code in messages
    ? remote.code as CashlogyErrorCode
    : fallback
  return new CashlogyError({
    code,
    originalCode: typeof remote?.originalCode === 'string'
      ? remote.originalCode
      : typeof remote?.code === 'string' && !(remote.code in messages) ? remote.code : null,
    details,
  })
}

export function isUncertainCashlogyError(error: unknown) {
  return error instanceof PrintAgentError
    && (['NETWORK_ERROR', 'TIMEOUT', 'ABORTED'].includes(error.code) || error.status === 502)
}
