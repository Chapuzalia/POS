import { COMMON_TAX_RATES } from '../../../../lib/tax'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { Building2, Plus, Save, X } from 'lucide-react'
import { sileo } from 'sileo'
import { type CatalogProfile, type CrmVenue, type TenantContext } from '../../../../types'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { type RunAction } from '../../shared/types'
import { createCrmVenue, updateCrmVenueSettings } from '../../access/services/accessService'
import { type CrmPlan, loadCrmPlan } from '../../plan/services/planService'

export type SettingsCrmProps = {
  disabled: boolean
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
  venues: CrmVenue[]
}

const venueTemplates: Array<{
  description: string
  label: string
  value: CatalogProfile
}> = [
  {
    value: 'bar_classic',
    label: 'Bar clásico',
    description: 'Crea formatos de bebidas y una estructura inicial para combinados, cervezas y refrescos.',
  },
  {
    value: 'restaurant',
    label: 'Restaurante',
    description: 'Activa la gestión de mesas y prepara carta, formatos y categorías de restauración.',
  },
  {
    value: 'custom',
    label: 'En blanco',
    description: 'Crea el local sin categorías ni formatos para configurarlo manualmente desde cero.',
  },
]

const templateLabels = new Map(venueTemplates.map((template) => [template.value, template.label]))

export function VenueSettingsCrm({ disabled, onVenuesChanged, runAction, tenantContext, venues }: SettingsCrmProps) {
  const [plan, setPlan] = useState<CrmPlan | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newVenueName, setNewVenueName] = useState('')
  const [newVenueProfile, setNewVenueProfile] = useState<CatalogProfile>('bar_classic')

  const refreshPlan = useCallback(async () => {
    setPlan(await loadCrmPlan(tenantContext))
  }, [tenantContext])

  useEffect(() => {
    void runAction(refreshPlan)
  }, [refreshPlan, runAction])

  async function submitVenueSettings(event: FormEvent<HTMLFormElement>, venue: CrmVenue) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const defaultTaxRate = Number(formData.get('defaultTaxRate'))
    const name = String(formData.get('name') ?? '').trim()
    const settings = {
      address: String(formData.get('address') ?? ''),
      dayChangeTime: String(formData.get('dayChangeTime') ?? '') || null,
      defaultTaxRate,
      legalName: String(formData.get('legalName') ?? ''),
      name,
      taxId: String(formData.get('taxId') ?? ''),
    }

    await runAction(async () => {
      await updateCrmVenueSettings(tenantContext, venue.id, settings)
      await onVenuesChanged()
      sileo.success({
        description: `Los productos que heredan IVA en ${name} usarán el ${defaultTaxRate} % en futuras ventas.`,
        title: 'Configuración del local actualizada',
      })
    })
  }

  async function submitNewVenue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newVenueName.trim()
    if (!name || !plan || plan.usage.venues >= plan.limits.venues) return

    await runAction(async () => {
      await createCrmVenue(tenantContext, name, newVenueProfile)
      await Promise.all([onVenuesChanged(), refreshPlan()])
      setNewVenueName('')
      setNewVenueProfile('bar_classic')
      setIsCreateOpen(false)
      sileo.success({
        description: `Se ha aplicado la plantilla ${templateLabels.get(newVenueProfile) ?? 'seleccionada'}.`,
        title: `${name} creado correctamente`,
      })
    })
  }

  const venueUsage = plan?.usage.venues ?? venues.length
  const venueLimit = plan?.limits.venues ?? null
  const hasVenueCapacity = venueLimit !== null && venueUsage < venueLimit
  const selectedTemplate = venueTemplates.find((template) => template.value === newVenueProfile) ?? venueTemplates[0]

  return (
    <>
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[72px] !flex-col !items-stretch !justify-between !gap-4 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] sm:!flex-row sm:!items-center md:!px-[22px]">
          <div>
            <h2 className="!m-0 !text-base !font-bold">Configuración de locales</h2>
            <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Edita sus datos fiscales, cambia el nombre o crea un local desde una plantilla.</p>
          </div>
          <div className="!flex !items-center !justify-between !gap-3 sm:!justify-end">
            <span className="!text-xs !font-semibold !text-[var(--crm-text-muted)]">
              {venueLimit === null ? 'Consultando plan…' : `${venueUsage} / ${venueLimit} locales`}
            </span>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white"
              disabled={disabled || !hasVenueCapacity}
              onClick={() => setIsCreateOpen(true)}
              title={!hasVenueCapacity && venueLimit !== null ? 'Has alcanzado el límite de locales de tu plan' : undefined}
              type="button"
            >
              <Plus className="h-4 w-4" /> Nuevo local
            </button>
          </div>
        </div>
        <div className="!grid !grid-cols-1 !gap-4 !px-[18px] !pt-5 !pb-[22px] md:!grid-cols-2 md:!px-[22px] xl:!grid-cols-3">
          {venues.map((venue) => (
            <form className="!grid !gap-3 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !p-4" key={venue.id} onSubmit={(event) => void submitVenueSettings(event, venue)}>
              <div className="!flex !items-center !justify-between !gap-3">
                <strong className="!text-[13px] !text-[var(--crm-text)]">{venue.name}</strong>
                <span className="!text-[10px] !font-semibold !text-[var(--crm-text-muted)]">{templateLabels.get(venue.catalogProfile) ?? 'Personalizado'}</span>
              </div>
              <Field label="Nombre del local">
                <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.name} disabled={disabled} maxLength={80} name="name" required />
              </Field>
              <Field label="Razón social">
                <input autoComplete="organization" className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.legalName} disabled={disabled} maxLength={80} name="legalName" placeholder="Empresa Ejemplo SL" />
              </Field>
              <Field label="NIF/CIF">
                <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.taxId} disabled={disabled} maxLength={80} name="taxId" placeholder="B12345678" />
              </Field>
              <Field label="Dirección">
                <textarea autoComplete="street-address" className="crm-input !min-h-20 !w-full !resize-y !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !py-3 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" defaultValue={venue.address} disabled={disabled} maxLength={300} name="address" placeholder="Calle, número, localidad" rows={2} />
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
              <Field label="Hora de cambio de día">
                <input
                  className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
                  defaultValue={venue.dayChangeTime ?? ''}
                  disabled={disabled}
                  name="dayChangeTime"
                  step={60}
                  type="time"
                />
              </Field>
              <p className="crm-form-help">Vacío usa días naturales. Si indicas una hora, las ventas anteriores se contabilizan en el día operativo anterior.</p>
              <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)]" disabled={disabled} type="submit">
                <Save className="h-4 w-4" /> Guardar configuración
              </button>
            </form>
          ))}
          {!venues.length ? <EmptyList message="No hay locales configurados." /> : null}
        </div>
      </section>

      {isCreateOpen ? (
        <CrmModal label="Crear nuevo local" onClose={() => setIsCreateOpen(false)}>
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
            <div>
              <h2 className="!m-0 !text-lg !font-bold">Nuevo local</h2>
              <p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Elige una plantilla para preparar su catálogo inicial.</p>
            </div>
            <button aria-label="Cerrar" className="crm-icon-button !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={() => setIsCreateOpen(false)} type="button"><X className="!size-4" /></button>
          </div>
          <form className="!grid !gap-4 !px-5 !py-5" onSubmit={(event) => void submitNewVenue(event)}>
            <Field label="Nombre del local">
              <input autoFocus className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !outline-none" disabled={disabled} maxLength={80} onChange={(event) => setNewVenueName(event.target.value)} required value={newVenueName} />
            </Field>
            <Field label="Plantilla">
              <CrmSelect
                disabled={disabled}
                onChange={(value) => setNewVenueProfile(value as CatalogProfile)}
                options={venueTemplates.map((template) => ({ label: template.label, value: template.value }))}
                required
                value={newVenueProfile}
              />
            </Field>
            <div className="!flex !items-start !gap-3 !rounded-[12px] !bg-[var(--crm-surface-soft)] !p-4">
              <div className="!grid !size-9 !shrink-0 !place-items-center !rounded-[9px] !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><Building2 className="!size-4" /></div>
              <div><strong className="!text-[13px]">{selectedTemplate.label}</strong><p className="!mt-1 !mb-0 !text-xs !leading-5 !text-[var(--crm-text-muted)]">{selectedTemplate.description}</p></div>
            </div>
            <div className="!flex !justify-end !gap-2 !border-t !border-[var(--crm-border)] !pt-4">
              <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text)]" onClick={() => setIsCreateOpen(false)} type="button">Cancelar</button>
              <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !newVenueName.trim() || !hasVenueCapacity} type="submit"><Plus className="!size-4" />Crear local</button>
            </div>
          </form>
        </CrmModal>
      ) : null}
    </>
  )
}
