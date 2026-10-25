import { requireSupabase } from '../crm/shared/services/crmServiceSupport'
import { UserFacingError } from '../../utils/UserFacingError'

export async function billingRequest<T>(body: object): Promise<T> {
  const { data, error } = await requireSupabase().functions.invoke<T & { error?: string }>('billing', { body })
  if (error || !data || data.error) {
    throw new UserFacingError(data?.error ?? 'La facturación no está disponible. Comprueba la configuración sandbox o vuelve a intentarlo más tarde.')
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
