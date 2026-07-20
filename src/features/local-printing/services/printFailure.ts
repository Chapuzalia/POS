import type { SessionTicketRecord } from '../../../types'

export function getPrintFailurePatch(errorCode: string, requestId: string) {
  return {
    printStatus: errorCode === 'PRINT_STATUS_UNKNOWN' ? 'unknown' as const : 'failed' as const,
    printErrorCode: errorCode,
    printRequestId: requestId,
  }
}

export function applyPrintFailure(
  ticket: SessionTicketRecord,
  errorCode: string,
  requestId: string,
): SessionTicketRecord {
  return { ...ticket, ...getPrintFailurePatch(errorCode, requestId) }
}
