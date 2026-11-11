export type BillingAddress = { street: string; postalCode: string; city: string; province: string; countryCode: string }
export type BillingProfile = { legalName: string; taxId: string; email: string; address: BillingAddress }

export const emptyBillingAddress: BillingAddress = { street: '', postalCode: '', city: '', province: '', countryCode: 'ES' }
export function billingProfileReady(profile: BillingProfile) {
  return Boolean(profile.legalName.trim() && profile.taxId.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email.trim())
    && profile.address.street.trim() && profile.address.postalCode.trim() && profile.address.city.trim() && /^[A-Z]{2}$/.test(profile.address.countryCode))
}
