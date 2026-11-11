import { Checkbox } from '../../components/ui/Checkbox'
import { Input } from '../../components/ui/Input'
import type { SepaForm } from './sepa'
import { BillingProfileFields } from './BillingProfileFields'

export function SepaMandateFields({ value, disabled, onChange, withPayer = true }: { value: SepaForm; disabled: boolean; onChange: (value: SepaForm) => void; withPayer?: boolean }) {
  return <div className="!grid !gap-3">
    {withPayer ? <BillingProfileFields value={value} disabled={disabled} onChange={profile => onChange({ ...value, ...profile })} /> : null}
    <label className="!grid !gap-1 !text-sm">Titular de la cuenta<Input autoComplete="name" value={value.accountHolder} disabled={disabled} onChange={event => onChange({ ...value, accountHolder: event.target.value })} /></label>
    <label className="!grid !gap-1 !text-sm">IBAN<Input autoComplete="off" inputMode="text" spellCheck={false} placeholder="ES00 0000 0000 0000 0000 0000" value={value.iban} disabled={disabled} onChange={event => onChange({ ...value, iban: event.target.value.toUpperCase() })} /></label>
    <Checkbox checked={value.accepted} disabled={disabled} onChange={accepted => onChange({ ...value, accepted })}>Autorizo a Alteil Solutions SL, a través de Mollie, a cargar en esta cuenta las cuotas recurrentes de Tickit mediante adeudo directo SEPA. Puedo solicitar la devolución en las condiciones de mi banco.</Checkbox>
  </div>
}
