import { billingErrorMessages } from './errors.ts'
import { MollieRequestError } from './mollie.ts'

// Never log request bodies, provider messages, customer data or credentials.
export function billingFailureDiagnostic(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const code = Object.hasOwn(billingErrorMessages, message) ? message : 'BILLING_INTERNAL_ERROR'
  return {
    event: 'billing_request_failed', action, code,
    ...(error instanceof MollieRequestError ? { mollie: error.diagnostic } : {}),
  }
}
