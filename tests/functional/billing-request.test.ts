import { expect, it, vi } from 'vitest'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { billingRequest } from '../../src/features/billing/service'
import { UserFacingError } from '../../src/utils/UserFacingError'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../src/services/backendService', () => ({
  requireSupabase: () => ({ functions: { invoke } }),
}))

it('shows the reviewed billing message from a non-2xx response without consuming its body', async () => {
  const response = Response.json({ code: 'BILLING_PENDING_CHANGE', error: 'untrusted provider text' }, { status: 409 })
  invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) })
  await expect(billingRequest({ action: 'confirm' })).rejects.toThrow('Hay una modificación, calendario o condición de pago pendiente.')
  expect(response.bodyUsed).toBe(false)
})

it('supports reviewed messages from N-1 billing functions without an error code', async () => {
  const response = Response.json({ error: 'La vista previa ha caducado o el contrato ha cambiado. Actualiza y solicita otra vista previa.' }, { status: 409 })
  invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) })
  await expect(billingRequest({ action: 'confirm' })).rejects.toThrow('La vista previa ha caducado')
})

it.each([
  new FunctionsHttpError(new Response('<html>Gateway failure</html>', { status: 502 })),
  new FunctionsHttpError(Response.json({ error: 'private infrastructure diagnostic' }, { status: 500 })),
  new Error('private network diagnostic'),
])('falls back safely for malformed, unknown or network errors', async error => {
  invoke.mockResolvedValue({ data: null, error })
  await expect(billingRequest({ action: 'confirm' })).rejects.toEqual(new UserFacingError('La facturación no está disponible. Vuelve a intentarlo más tarde.'))
})

it('handles business errors returned with a successful HTTP status and returns successful data', async () => {
  const result = { url: 'https://checkout.stripe.com/test' }
  invoke.mockResolvedValueOnce({ data: { error: 'untrusted text', code: 'BILLING_INVALID_SELECTION' }, error: null })
  invoke.mockResolvedValueOnce({ data: result, error: null })
  await expect(billingRequest({ action: 'confirm' })).rejects.toThrow('La selección no cumple las reglas')
  await expect(billingRequest({ action: 'confirm' })).resolves.toEqual(result)
})
