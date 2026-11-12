export const billingLegalVersion = '2026-11-12.1'

// Keep previous editions at their versioned URLs when publishing new documents.
export const billingLegalDocuments = {
  terms: { title: 'Términos y Condiciones', version: '1.2-mollie.1', url: '/legal/2026-11-12/condiciones-saas.html', sha256: '687a0a8ad11293de4b1f80ab040f2118bf864e2b28970f5d5162276ce9100908' },
  dpa: { title: 'Contrato de encargo del tratamiento (DPA)', version: '1.3.1-mollie.1', url: '/legal/2026-11-12/dpa.html', sha256: '93fc411e98d6b71c8408c7c528304c90f8ffe6aa4dc80dc36f6eba6719675edb' },
  privacy: { title: 'Información de privacidad (art. 13 RGPD)', version: '1.3-mollie.1', url: '/legal/2026-11-12/privacidad.html', sha256: '74c567ab4c3349a3dd8f00931ef1fb743cb2ecd49f2a22e035529c68c86ed573' },
  notice: { title: 'Aviso legal', version: '1.2.1-integracion.1', url: '/legal/2026-11-12/aviso-legal.html', sha256: '825a701eea2933aaf93064b1a57cea86509500719f95450968ac749a8a8f6ff8' },
} as const

export type BillingLegalInput = { version: string; terms: boolean; dpa: boolean; businessRepresentative: boolean }
export const emptyLegalAcceptance: BillingLegalInput = { version: billingLegalVersion, terms: false, dpa: false, businessRepresentative: false }
export const legalAcceptanceReady = (value: BillingLegalInput) => value.version === billingLegalVersion && value.terms && value.dpa && value.businessRepresentative
export type BillingLegalReceipt = {
  operation_id: string; tenant_id: string; actor_id: string; accepted_at: string
  receipt: {
    version: string; documents: typeof billingLegalDocuments
    declarations: { terms: true; dpa: true; businessRepresentative: true }
    payer: { legalName: string; taxId: string; email?: string }
    contract: import('./domain.ts').Contract
    offer: { amountDueCents: number; recurringNetCents: number; recurringGrossCents: number; vatBasisPoints: number; currency: string; interval: 'month' | 'year'; automaticRenewal: true; firstPayment: 'card'; renewals: 'sepa' }
  }
}

export function requireBillingLegalAcceptance(input: BillingLegalInput | undefined) {
  if (!input || input.terms !== true || input.dpa !== true || input.businessRepresentative !== true) throw new Error('BILLING_LEGAL_REQUIRED')
  if (input.version !== billingLegalVersion) throw new Error('BILLING_LEGAL_VERSION')
}
