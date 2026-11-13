import { Input } from '../../components/ui/Input'
import type { BillingProfile } from '../../../supabase/functions/_shared/billing/profile'
import { BillingPrivacyNotice } from './BillingPrivacyNotice'

export function BillingProfileFields({ value, disabled, onChange }: { value: BillingProfile; disabled: boolean; onChange: (value: BillingProfile) => void }) {
  return <div className="!grid !gap-3 sm:!grid-cols-2">
    <div className="sm:!col-span-2"><BillingPrivacyNotice /></div>
    {([
      ['legalName', 'Razón social', 'organization'], ['taxId', 'NIF/CIF', 'off'], ['email', 'Email de facturación', 'email'],
    ] as const).map(([key, label, autoComplete]) => <label key={key} className="!grid !gap-1 !text-sm">{label}<Input className="!min-h-11" autoComplete={autoComplete} type={key === 'email' ? 'email' : 'text'} value={value[key]} disabled={disabled} maxLength={key === 'taxId' ? 40 : key === 'email' ? 254 : 200} onChange={event => onChange({ ...value, [key]: event.target.value })} /></label>)}
    {([
      ['street', 'Domicilio fiscal', 'street-address', 200], ['postalCode', 'Código postal', 'postal-code', 20],
      ['city', 'Ciudad', 'address-level2', 100], ['province', 'Provincia / región (opcional)', 'address-level1', 100], ['countryCode', 'País (código de dos letras, p. ej. ES)', 'country', 2],
    ] as const).map(([key, label, autoComplete, maxLength]) => <label key={key} className="!grid !gap-1 !text-sm">{label}<Input className="!min-h-11" autoComplete={autoComplete} value={value.address[key]} disabled={disabled} maxLength={maxLength} onChange={event => onChange({ ...value, address: { ...value.address, [key]: key === 'countryCode' ? event.target.value.toUpperCase() : event.target.value } })} /></label>)}
  </div>
}
