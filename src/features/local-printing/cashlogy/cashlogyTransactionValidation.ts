import { z } from 'zod'
import { PrintAgentError } from '../api/PrintAgentError.ts'
import type { CashlogyChargeRequest, CashlogyTransaction } from '../types.ts'

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const optionalCents = cents.nullish().transform(value => value ?? null)
const optionalText = z.string().nullish().transform(value => value ?? null)

const transactionSchema = z.object({
  id: z.string().min(1), requestId: z.string().min(1), saleId: optionalText,
  connectorId: z.string(), terminalCode: z.string().min(1), operationNumber: z.string(),
  status: z.enum([
    'queued', 'connecting', 'initializing', 'starting_acceptance', 'waiting_for_cash',
    'finalizing_acceptance', 'dispensing_change', 'processing',
    'completed', 'cancelled', 'failed', 'unknown', 'needs_attention',
  ]),
  requestedAmountCents: cents.positive(), automaticAcceptedCents: optionalCents,
  manualAcceptedCents: optionalCents, returnedCents: optionalCents,
  changeAddedCents: optionalCents, netPaidCents: optionalCents,
  connectorResultCode: optionalText, normalizedErrorCode: optionalText,
  error: z.object({ code: z.string(), message: z.string().nullable() }).nullish().transform(value => value ?? null),
  warning: z.object({ code: z.string(), message: z.string() }).nullish().transform(value => value ?? null),
  test: z.boolean(), cancelRequestedAt: optionalText, startedAt: optionalText, completedAt: optionalText,
  createdAt: z.string(), updatedAt: z.string(),
})

export type ExpectedTransaction = Partial<Pick<CashlogyTransaction, 'id' | 'requestId' | 'saleId' | 'terminalCode' | 'requestedAmountCents' | 'test'>>

export function validateCashlogyTransactionResponse(value: unknown, expected: ExpectedTransaction = {}): CashlogyTransaction {
  const envelope = z.object({ ok: z.literal(true).optional(), duplicate: z.boolean().optional(), transaction: transactionSchema }).safeParse(value)
  if (!envelope.success) throw new PrintAgentError({ code: 'INVALID_RESPONSE' })
  const transaction = envelope.data.transaction
  const identityKeys = ['id', 'requestId', 'saleId', 'terminalCode', 'requestedAmountCents', 'test'] as const
  const mismatch = identityKeys.some(key => {
    const expectedValue = expected[key]
    if (expectedValue === undefined) return false
    // Older agents can omit the optional saleId; the local intent still owns it.
    if (key === 'saleId' && transaction.saleId === null) return false
    return transaction[key] !== expectedValue
  })
  const accepted = (transaction.automaticAcceptedCents ?? 0) + (transaction.manualAcceptedCents ?? 0)
  const cashMismatch = transaction.status === 'completed' && transaction.automaticAcceptedCents !== null
    && transaction.manualAcceptedCents !== null && transaction.returnedCents !== null
    && (!Number.isSafeInteger(accepted) || accepted - transaction.returnedCents !== transaction.requestedAmountCents)
  if (mismatch || cashMismatch || (transaction.status === 'completed' && transaction.netPaidCents !== null
    && transaction.netPaidCents !== transaction.requestedAmountCents)) {
    throw new PrintAgentError({ code: 'INVALID_RESPONSE' })
  }
  return transaction
}

export function expectedCashlogyCharge(payload: CashlogyChargeRequest): ExpectedTransaction {
  return {
    requestId: payload.requestId, saleId: payload.saleId ?? null,
    requestedAmountCents: payload.amountCents, terminalCode: payload.terminalCode, test: payload.test ?? false,
  }
}
