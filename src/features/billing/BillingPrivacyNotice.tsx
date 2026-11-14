import { billingLegalDocuments } from '../../../supabase/functions/_shared/billing/legal'

export function BillingPrivacyNotice() {
  return <aside aria-label="Información básica de privacidad" className="!text-xs !leading-relaxed !text-[var(--crm-text-muted)]">
    <p className="!m-0">Alteil Solutions SL trata estos datos para gestionar la contratación, facturación y cobros, por contrato, obligaciones legales e interés legítimo en la relación profesional, según corresponda. Mollie recibe los datos necesarios para el pago. La aceptación contractual y el mandato SEPA no son un consentimiento general sobre tus datos.</p>
    <p className="!m-0">Derechos y oposición: <a className="!underline !underline-offset-2" href="mailto:info@alteilsolutions.com">info@alteilsolutions.com</a>. <a className="!inline-flex !min-h-11 !items-center !text-[var(--crm-blue)] !underline !underline-offset-2" href={billingLegalDocuments.privacy.url} target="_blank" rel="noreferrer">Información completa de privacidad</a>.</p>
  </aside>
}
