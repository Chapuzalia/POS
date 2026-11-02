import { FunctionsHttpError } from '@supabase/supabase-js'
import { billingErrorMessages } from '../../../supabase/functions/_shared/billing/errors'
import { requireSupabase } from '../../services/backendService'
import { UserFacingError } from '../../utils/UserFacingError'

function publicBillingMessage(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const byCode = 'code' in value ? Object.entries(billingErrorMessages).find(([code]) => code === value.code)?.[1] : undefined
  // N-1 functions return only the message. Match local reviewed text, never raw errors.
  return byCode ?? ('error' in value ? Object.values(billingErrorMessages).find(message => message === value.error) : undefined)
}

export async function billingRequest<T>(body: object): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke<T & { error?: string }>('billing', { body })
  if (error || !data || data.error) {
    let message = publicBillingMessage(data)
    if (!message && error instanceof FunctionsHttpError && error.context instanceof Response) {
      try {
        const response: unknown = await error.context.clone().json()
        message = publicBillingMessage(response)
      } catch { /* Gateways and network failures may not return a billing response. */ }
    }
    throw new UserFacingError(message || 'La facturación no está disponible. Vuelve a intentarlo más tarde.')
  }
  return data
}

export const billingMoney = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
export const billingDate = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(new Date(value)) : '—'

export function openBillingUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['checkout.stripe.com','billing.stripe.com','invoice.stripe.com','pay.stripe.com'].includes(url.hostname)) throw new UserFacingError('Stripe no devolvió una dirección válida.')
  window.location.assign(url.href)
}
