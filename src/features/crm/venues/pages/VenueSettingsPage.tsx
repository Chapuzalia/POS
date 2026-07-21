import { COMMON_TAX_RATES } from '../../../../lib/tax'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { Save, Settings } from 'lucide-react'
import { sileo } from 'sileo'
import { type CrmVenue, type TenantContext } from '../../../../types'
import { type FormEvent } from 'react'
import { type RunAction } from '../../shared/types'
import { updateCrmVenueSettings } from '../../access/services/accessService'

export type SettingsCrmProps = {
  disabled: boolean
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
  venues: CrmVenue[]
}

export function VenueSettingsCrm({ disabled, onVenuesChanged, runAction, tenantContext, venues }: SettingsCrmProps) {
  async function submitVenueSettings(event: FormEvent<HTMLFormElement>, venue: CrmVenue) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const defaultTaxRate = Number(formData.get('defaultTaxRate'))
    const settings = {
      address: String(formData.get('address') ?? ''),
      defaultTaxRate,
      legalName: String(formData.get('legalName') ?? ''),
      taxId: String(formData.get('taxId') ?? ''),
    }

    await runAction(async () => {
      await updateCrmVenueSettings(tenantContext, venue.id, settings)
      await onVenuesChanged()
      sileo.success({
        description: `Los productos que heredan IVA en ${venue.name} usarán el ${defaultTaxRate} % en futuras ventas.`,
        title: 'Configuraci\u00f3n del local actualizada',
      })
    })
  }

  return (
    <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
      <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <h2 className="!m-0 !text-base !font-bold">Configuración de locales</h2>
          <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Define los datos fiscales del ticket y el IVA por defecto de cada local.</p>
        </div>
        <Settings className="h-4 w-4" />
      </div>
      <div className="!grid !grid-cols-1 !gap-4 !px-[18px] !pt-5 !pb-[22px] md:!grid-cols-2 md:!px-[22px] xl:!grid-cols-3">
        {venues.map((venue) => (
          <form className="!grid !gap-3 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !p-4" key={venue.id} onSubmit={(event) => void submitVenueSettings(event, venue)}>
            <strong className="!text-[13px] !text-[var(--crm-text)]">{venue.name}</strong>
            <Field label={'Raz\u00f3n social'}>
              <input autoComplete="organization" className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.legalName} disabled={disabled} maxLength={80} name="legalName" placeholder="Empresa Ejemplo SL" />
            </Field>
            <Field label="NIF/CIF">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.taxId} disabled={disabled} maxLength={80} name="taxId" placeholder="B12345678" />
            </Field>
            <Field label={'Direcci\u00f3n'}>
              <textarea autoComplete="street-address" className="crm-input !min-h-20 !w-full !resize-y !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !py-3 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.address} disabled={disabled} maxLength={300} name="address" placeholder={'Calle, n\u00famero, localidad'} rows={2} />
            </Field>
            <Field label="IVA por defecto">
              <CrmSelect
                defaultValue={String(venue.defaultTaxRate)}
                disabled={disabled}
                name="defaultTaxRate"
                options={COMMON_TAX_RATES.map((rate) => ({ label: rate + ' %', value: String(rate) }))}
              />
            </Field>
            <p className="crm-form-help">Se aplicará a los productos que no tengan un IVA específico.</p>
            <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)]" disabled={disabled} type="submit">
              <Save className="h-4 w-4" /> {'Guardar configuraci\u00f3n'}
            </button>
          </form>
        ))}
        {!venues.length ? <EmptyList message="No hay locales configurados." /> : null}
      </div>
    </section>
  )
}
