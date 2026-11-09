// The IBAN only travels to the billing function to create the Mollie mandate; it is never persisted here.
export type SepaForm = { legalName: string; taxId: string; accountHolder: string; iban: string; accepted: boolean }
export const emptySepaForm: SepaForm = { legalName: '', taxId: '', accountHolder: '', iban: '', accepted: false }
// A new IBAN for an existing customer does not ask for the company details again.
export const sepaFormReady = (sepa: SepaForm, withPayer = true) => sepa.accepted && (!withPayer || (Boolean(sepa.legalName.trim()) && Boolean(sepa.taxId.trim()))) && sepa.accountHolder.trim().length >= 2 && sepa.iban.replace(/\s/g, '').length >= 15
export const sepaConfirmInput = (sepa: SepaForm) => ({ sepa: { accountHolder: sepa.accountHolder, iban: sepa.iban }, payer: { legalName: sepa.legalName, taxId: sepa.taxId } })
