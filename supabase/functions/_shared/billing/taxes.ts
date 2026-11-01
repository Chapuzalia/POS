import type { StripeGateway } from './stripe.ts'

type TaxRate = {
  id: string; active: boolean; percentage: number; inclusive: boolean
  country: string | null; tax_type: string | null; metadata: Record<string, string>
}
const policy = 'es_vat_21_exclusive_v1'
const matches = (rate: TaxRate) => rate.active && rate.percentage === 21 && !rate.inclusive
  && rate.country === 'ES' && rate.tax_type === 'vat' && rate.metadata.tickit_tax_policy === policy

// The rate belongs to the Stripe account, not to a tenant. Reuse it across contracts.
export async function spanishVatRate(stripe: StripeGateway): Promise<string> {
  const rates = await stripe.list<TaxRate>('/tax_rates', { active: true })
  const rate = rates.find(matches) ?? await stripe.request<TaxRate>('POST', '/tax_rates', {
    display_name: 'IVA', description: 'IVA España 21 % (Tickit)', country: 'ES', jurisdiction: 'España',
    percentage: 21, inclusive: false, tax_type: 'vat', metadata: { tickit_tax_policy: policy },
  }, `tickit:tax:${policy}`)
  if (!matches(rate)) throw new Error('BILLING_STRIPE_TAX_MISMATCH')
  return rate.id
}
