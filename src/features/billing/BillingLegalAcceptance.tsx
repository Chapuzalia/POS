import { Checkbox } from '../../components/ui/Checkbox'
import { billingLegalDocuments } from '../../../supabase/functions/_shared/billing/legal'
import type { BillingLegalInput } from '../../../supabase/functions/_shared/billing/legal'
import { grossCents } from '../../../supabase/functions/_shared/billing/mollie'
import { billingMoney } from './service'
import type { BillingCatalog, BillingOperation } from './types'

const linkClass = '!text-[var(--crm-blue)] !underline !underline-offset-2'

export function BillingLegalLinks({ informationalOnly = false }: { informationalOnly?: boolean }) {
  const documents = informationalOnly ? [billingLegalDocuments.privacy, billingLegalDocuments.notice] : Object.values(billingLegalDocuments)
  return <nav aria-label="Documentación legal" className="!flex !flex-wrap !gap-x-4 !text-xs">{documents.map(doc => <a key={doc.url} className={`${linkClass} !inline-flex !min-h-11 !items-center`} href={doc.url} target="_blank" rel="noreferrer">{doc === billingLegalDocuments.privacy ? 'Privacidad' : doc.title}</a>)}</nav>
}

export function BillingOfferSummary({ quote, catalog }: { quote: BillingOperation; catalog: BillingCatalog | null }) {
  const contract = quote.contract
  return <section aria-label="Resumen de la oferta" className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4 !text-sm">
    <div className="!flex !items-start !justify-between !gap-4">
      <div><p className="!m-0 !font-semibold">{contract?.planName}</p>{contract ? <p className="!mb-0 !mt-1 !text-xs !text-[var(--crm-text-muted)]">{contract.limits.venues} {contract.limits.venues === 1 ? 'local' : 'locales'} · {contract.limits.devices} dispositivos</p> : null}</div>
      <div className="!shrink-0 !text-right"><p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">Primer pago</p><strong className="!text-xl !tabular-nums">{billingMoney(quote.preview.amountDueCents)}</strong><p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">IVA incluido</p></div>
    </div>
    {contract ? <div className="!border-t !border-[var(--crm-border)] !pt-3">
      <p className="!m-0">Después, <strong>{billingMoney(grossCents(contract.recurringCents))} / {contract.interval === 'year' ? 'año' : 'mes'}</strong> <span className="!text-xs !text-[var(--crm-text-muted)]">({billingMoney(contract.recurringCents)} + IVA 21 %)</span></p>
      {contract.addons.some(addon => addon.quantity > 0) ? <p className="!mb-0 !mt-2 !text-xs !text-[var(--crm-text-muted)]">{contract.addons.filter(addon => addon.quantity > 0).map(addon => `${catalog?.products.find(product => product.key === addon.key)?.name ?? addon.key} × ${addon.quantity}`).join(' · ')}</p> : null}
      <p className="!mb-0 !mt-2 !text-xs !text-[var(--crm-text-muted)]">Renovación automática. Baja ordinaria para la próxima renovación. <a className={linkClass} href="/legal/portabilidad.html" target="_blank" rel="noreferrer">Cambio de proveedor y recuperación de datos conforme a los Términos.</a></p>
    </div> : null}
  </section>
}

export function BillingLegalAcceptance({ value, disabled, onChange }: { value: BillingLegalInput; disabled: boolean; onChange: (value: BillingLegalInput) => void }) {
  return <section aria-label="Condiciones de contratación" className="!grid !gap-2 !border-t !border-[var(--crm-border)] !pt-4 !text-sm">
    <Checkbox className="!items-start !font-normal [&_input]:!mt-0.5" checked={value.terms} disabled={disabled} onChange={terms => onChange({ ...value, terms, businessRepresentative: terms })}>Acepto la oferta y los <a className={linkClass} href={billingLegalDocuments.terms.url} target="_blank" rel="noreferrer">Términos y Condiciones</a> como profesional o representante autorizado del negocio.</Checkbox>
    <Checkbox className="!items-start !font-normal [&_input]:!mt-0.5" checked={value.dpa} disabled={disabled} onChange={dpa => onChange({ ...value, dpa })}>Acepto el <a className={linkClass} href={billingLegalDocuments.dpa.url} target="_blank" rel="noreferrer">contrato de encargo de datos (DPA)</a>.</Checkbox>
    <details className="!mt-1 !text-xs !text-[var(--crm-text-muted)]">
      <summary className="!flex !min-h-11 !cursor-pointer !items-center !gap-1">Detalles de la contratación <span aria-hidden="true">⌄</span></summary>
      <div className="!grid !gap-2 !pb-2 !leading-relaxed">
        <p className="!m-0">Primera cuota con tarjeta en Mollie; siguientes por SEPA. Renovación por periodos iguales. Sin reembolso del periodo en curso, salvo las excepciones de los Términos y Condiciones.</p>
        <p className="!m-0">Contratación en español. Puedes corregir el plan y tus datos volviendo atrás. La aceptación y una copia de los documentos se guardan en Mi plan. El servicio se activa al confirmarse el pago.</p>
      </div>
    </details>
    <div className="!flex !flex-wrap !items-center !justify-between !gap-x-3 !border-t !border-[var(--crm-border)] !pt-1">
      <span className="!text-xs !text-[var(--crm-text-muted)]">Justificante disponible en Mi plan</span>
      <BillingLegalLinks informationalOnly />
    </div>
  </section>
}
