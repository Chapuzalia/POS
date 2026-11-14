// The IBAN only travels to the billing function to create the Mollie mandate; it is never persisted here.
import { billingProfileReady, emptyBillingAddress } from '../../../supabase/functions/_shared/billing/profile'
import type { BillingProfile } from '../../../supabase/functions/_shared/billing/profile'
import { sepaAuthorizationVersion } from '../../../supabase/functions/_shared/billing/sepa'
import type { SepaEvidence } from '../../../supabase/functions/_shared/billing/sepa'

export type SepaForm = BillingProfile & { accountHolder: string; iban: string; accepted: boolean }
export const emptySepaForm: SepaForm = { legalName: '', taxId: '', email: '', address: emptyBillingAddress, accountHolder: '', iban: '', accepted: false }
// A new IBAN for an existing customer does not ask for the company details again.
export const sepaFormReady = (sepa: SepaForm, withPayer = true) => sepa.accepted && (!withPayer || billingProfileReady(sepa)) && sepa.accountHolder.trim().length >= 2 && sepa.iban.replace(/\s/g, '').length >= 15
export const sepaMandateInput = (sepa: Pick<SepaForm, 'accountHolder' | 'iban' | 'accepted'>) => ({ accountHolder: sepa.accountHolder, iban: sepa.iban, authorization: { version: sepaAuthorizationVersion, accepted: sepa.accepted } })
export const sepaConfirmInput = (sepa: SepaForm) => ({ sepa: sepaMandateInput(sepa), payer: { legalName: sepa.legalName, taxId: sepa.taxId, email: sepa.email.trim(), address: sepa.address } })

export function downloadSepaEvidence(evidence: SepaEvidence) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `Tickit-mandato-${evidence.reference}.json`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
