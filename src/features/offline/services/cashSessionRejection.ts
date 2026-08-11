import type { OfflineEvent } from '../../../types'

type DatabaseError = {
  code?: unknown
  details?: unknown
  message?: unknown
}

type RejectedSaleEvent = Extract<OfflineEvent, { kind: 'sale_created' }>

const closedCashMessages = [
  'caja cerrada',
  'caja indicada no existe',
]

/**
 * Only cash-session failures may activate the recovery flow that removes the
 * current cash session. Generic PostgreSQL errors are also used by inventory,
 * reservations and payload validation, so their SQLSTATE alone is not enough.
 */
export function isClosedCashSaleRejection(
  event: OfflineEvent,
  error: unknown,
): event is RejectedSaleEvent {
  if (event.kind !== 'sale_created' || !error || typeof error !== 'object') {
    return false
  }

  const databaseError = error as DatabaseError
  const messages = [databaseError.message, databaseError.details]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLocaleLowerCase('es'))

  return String(databaseError.code) === '55000'
    || messages.some((message) => closedCashMessages.some((fragment) => message.includes(fragment)))
}
