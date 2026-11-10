// The IBAN only travels to the billing function to create the Mollie mandate; it is never persisted here.
import { billingProfileReady, emptyBillingAddress } from '../../../supabase/functions/_shared/billing/profile'
import type { BillingProfile } from '../../../supabase/functions/_shared/billing/profile'

export type SepaForm = BillingProfile & { accountHolder: string; iban: string; accepted: boolean }
export const emptySepaForm: SepaForm = { legalName: '', taxId: '', email: '', address: emptyBillingAddress, accountHolder: '', iban: '', accepted: false }
// A new IBAN for an existing customer does not ask for the company details again.
export const sepaFormReady = (sepa: SepaForm, withPayer = true) => sepa.accepted && (!withPayer || billingProfileReady(sepa)) && sepa.accountHolder.trim().length >= 2 && sepa.iban.replace(/\s/g, '').length >= 15
export const sepaConfirmInput = (sepa: SepaForm) => ({ sepa: { accountHolder: sepa.accountHolder, iban: sepa.iban }, payer: { legalName: sepa.legalName, taxId: sepa.taxId, email: sepa.email.trim(), address: sepa.address } })
