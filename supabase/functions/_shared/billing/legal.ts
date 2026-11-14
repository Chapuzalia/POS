export const billingLegalVersion = '2026-11-13.4'

// Keep previous editions at their versioned URLs when publishing new documents.
export const billingLegalDocuments = {
  terms: { title: 'Términos y Condiciones', version: '1.4-saas.1', url: '/legal/2026-11-13-saas/condiciones-saas.html', sha256: '0505917093feae6deecd63a273dc9467578fba0112e480433c38c85a4704772c' },
  dpa: { title: 'Contrato de encargo del tratamiento (DPA)', version: '1.4-rgpd.1', url: '/legal/2026-11-13-rgpd/dpa.html', sha256: '32ff1a49508e2117242ae2ee3445b4f46b0d8d2724aeb351d2a0d4d0230fa643' },
  privacy: { title: 'Información de privacidad', version: '1.4-rgpd.2', url: '/legal/2026-11-13-saas/privacidad.html', sha256: 'cc5a8986f795b32619176301dfd9ad011eb9973cea6bb7a20b422bf3fc51b2ee' },
  notice: { title: 'Aviso legal', version: '1.3-lssi.1', url: '/legal/2026-11-13-saas/aviso-legal.html', sha256: '0437daa91af7cfab5dbbfc0380c1f0142fae0d2de5274b0f5478c1f247908e2b' },
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
    sepa?: import('./sepa.ts').SepaEvidence
    contract: import('./domain.ts').Contract
    offer: { amountDueCents: number; recurringNetCents: number; recurringGrossCents: number; vatBasisPoints: number; currency: string; interval: 'month' | 'year'; automaticRenewal: true; firstPayment: 'card'; renewals: 'sepa' }
  }
}

export function requireBillingLegalAcceptance(input: BillingLegalInput | undefined) {
  if (!input || input.terms !== true || input.dpa !== true || input.businessRepresentative !== true) throw new Error('BILLING_LEGAL_REQUIRED')
  if (input.version !== billingLegalVersion) throw new Error('BILLING_LEGAL_VERSION')
}
