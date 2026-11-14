import { Checkbox } from '../../components/ui/Checkbox'
import { Input } from '../../components/ui/Input'
import type { SepaForm } from './sepa'
import { BillingProfileFields } from './BillingProfileFields'
import { BillingPrivacyNotice } from './BillingPrivacyNotice'
import { mandateReference, sepaAuthorizationLabel, sepaAuthorizationText, sepaCreditor } from '../../../supabase/functions/_shared/billing/sepa'

export function SepaMandateFields({ value, disabled, onChange, withPayer = true, referenceId, replacement = false }: { value: SepaForm; disabled: boolean; onChange: (value: SepaForm) => void; withPayer?: boolean; referenceId?: string; replacement?: boolean }) {
  return <div className="!grid !gap-3">
    {withPayer ? <BillingProfileFields value={value} disabled={disabled} onChange={profile => onChange({ ...value, ...profile })} /> : <BillingPrivacyNotice />}
    <div className="!text-xs !leading-relaxed !text-[var(--crm-text-muted)]">
      <p className="!m-0"><strong>Mandato recurrente SEPA Core.</strong> Beneficiario: {sepaCreditor.beneficiary}, NIF {sepaCreditor.taxId}. {sepaCreditor.address}.</p>
      <p className="!m-0">Acreedor de los adeudos: {sepaCreditor.collectingCreditor}. Identificador SEPA: {sepaCreditor.identifier}.</p>
      <p className="!m-0 !break-all">Referencia del mandato: {referenceId ? mandateReference(referenceId, replacement) : 'Se asignará y facilitará antes del primer adeudo.'}</p>
    </div>
    <label className="!grid !gap-1 !text-sm">Titular de la cuenta<Input autoComplete="name" value={value.accountHolder} disabled={disabled} onChange={event => onChange({ ...value, accountHolder: event.target.value })} /></label>
    <label className="!grid !gap-1 !text-sm">IBAN<Input autoComplete="off" inputMode="text" spellCheck={false} placeholder="ES00 0000 0000 0000 0000 0000" value={value.iban} disabled={disabled} onChange={event => onChange({ ...value, iban: event.target.value.toUpperCase() })} /></label>
    <details className="!text-xs !leading-relaxed !text-[var(--crm-text-muted)]">
      <summary className="!flex !min-h-11 !cursor-pointer !items-center !gap-2">Ver condiciones del mandato y derechos de devolución <span aria-hidden="true">⌄</span></summary>
      <p className="!mb-2 !mt-0">{sepaAuthorizationText}</p>
    </details>
    <Checkbox checked={value.accepted} disabled={disabled} onChange={accepted => onChange({ ...value, accepted })}>{sepaAuthorizationLabel}</Checkbox>
  </div>
}
