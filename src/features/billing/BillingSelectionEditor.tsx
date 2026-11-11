import { Checkbox } from '../../components/ui/Checkbox'
import { Input } from '../../components/ui/Input'
import { billingMoney } from './service'
import { buildContract, changeBillingPlan, currentBillingVersions } from './selection'
import type { BillingCatalog, Selection } from './types'

const field = '!min-h-11 !w-full !rounded-[10px] !border !border-[var(--crm-border)] !bg-[var(--crm-input-bg)] !px-3 !py-2 !text-sm'
type Props = { catalog: BillingCatalog; selection: Selection; onChange: (selection: Selection) => void; disabled?: boolean; venues?: Array<{ id: string; name: string; is_active: boolean }>; devices?: Array<{ id: string; name: string }> }

export function BillingSelectionEditor({ catalog, selection, onChange, disabled, venues, devices = [] }: Props) {
  const versions = currentBillingVersions(catalog)
  const plan = catalog.versions.find(version => version.id === selection.planVersionId)
  const plans = versions.filter(version => catalog.products.some(product => product.active && product.kind === 'plan' && product.key === version.productKey))
  let contract = null
  try { contract = buildContract(catalog.products, catalog.versions, selection) } catch { /* Explain incomplete selections below. */ }
  return <div className="!grid !gap-4">
    <label className="!grid !gap-2 !text-sm !font-semibold">Plan y periodicidad
      <select aria-label="Plan y periodicidad" className={field} disabled={disabled} value={selection.planVersionId} onChange={event => onChange(changeBillingPlan(catalog, selection, event.target.value))} required>
        <option value="">Selecciona un plan</option>
        {plans.map(version => <option key={version.id} value={version.id}>{catalog.products.find(product => product.key === version.productKey)?.name} · {billingMoney(version.amountCents)} / {version.interval === 'month' ? 'mes' : 'año'}</option>)}
      </select>
    </label>
    {!plans.length ? <p role="status" className="!text-sm">No hay planes publicados. Configura y publica las tarifas en Facturación.</p> : null}
    {plan ? <>
      <p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">Incluye {plan.limits.venues} {plan.limits.venues === 1 ? 'local' : 'locales'} y {plan.limits.devices} dispositivos. Precios sin IVA.</p>
      <div className="!grid !gap-3"><h4 className="!m-0 !text-sm !font-semibold">Extras opcionales</h4>
        {catalog.products.filter(product => product.active && product.kind === 'addon').map(product => {
          const addon = selection.addons.find(row => row.key === product.key)
          const version = versions.find(row => row.productKey === product.key && row.interval === plan.interval)
          if (!version) return null
          const included = product.featureKey && plan.features.includes(product.featureKey)
          if (included) return <p className="!m-0 !text-sm" key={product.key}>{product.name} · Incluido en el plan</p>
          const update = (quantity: number, venueIds = addon?.venueIds ?? [], deviceIds = addon?.deviceIds ?? []) => onChange({ ...selection, addons: [
            ...selection.addons.filter(row => row.key !== product.key),
            ...(quantity > 0 ? [{ key: product.key, versionId: version.id, quantity, venueIds: venueIds.slice(0, quantity), deviceIds: deviceIds.slice(0, quantity) }] : []),
          ] })
          const isToggle = product.scope === 'tenant' && !product.resource
          return <div className="!grid !gap-3 !rounded-[10px] !border !border-[var(--crm-border)] !p-3" key={product.key}>
            <div className="!flex !flex-wrap !items-center !justify-between !gap-3">
              <div className="!min-w-0 !flex-1"><strong className="!text-sm">{product.name}</strong><p className="!m-0 !mt-1 !text-xs !text-[var(--crm-text-muted)]">{product.description || `${billingMoney(version.amountCents)} por ${product.scope === 'venue' ? 'local' : product.scope === 'device' ? 'dispositivo' : 'unidad'}`} · {billingMoney(version.amountCents)} / {plan.interval === 'month' ? 'mes' : 'año'}{plan.included[product.key] ? ` · ${plan.included[product.key]} incluidos` : ''}</p></div>
              {isToggle ? <Checkbox checked={Boolean(addon?.quantity)} disabled={disabled} onChange={checked => update(checked ? 1 : 0)}>Añadir {product.name}</Checkbox> : <label className="!grid !gap-1 !text-xs">Unidades<Input aria-label={`Unidades de ${product.name}`} className={`${field} !w-24`} disabled={disabled} type="number" min={0} max={version.maximum ?? 100000} value={addon?.quantity ?? 0} onChange={event => {
                const quantity = Number(event.target.value)
                update(quantity, !addon?.quantity && quantity > 0 && product.scope === 'venue' && venues?.length === 1 ? [venues[0].id] : undefined)
              }} /></label>}
            </div>
            {product.scope === 'venue' && Boolean(addon?.quantity) ? venues ? <div className="!flex !flex-wrap !gap-3">{venues.filter(venue => venue.is_active).map(venue => <Checkbox key={venue.id} checked={addon?.venueIds.includes(venue.id) ?? false} disabled={disabled} onChange={checked => update(addon?.quantity ?? 0, checked ? [...(addon?.venueIds ?? []), venue.id] : addon?.venueIds.filter(id => id !== venue.id))}>{venue.name}</Checkbox>)}</div> : <p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">Se activará en el primer local. Las unidades restantes podrán asignarse a futuros locales.</p> : null}
            {product.scope === 'device' && Boolean(addon?.quantity) && devices.length ? <div className="!flex !flex-wrap !gap-3">{devices.map(device => <Checkbox key={device.id} checked={addon?.deviceIds.includes(device.id) ?? false} disabled={disabled} onChange={checked => update(addon?.quantity ?? 0, [], checked ? [...(addon?.deviceIds ?? []), device.id] : addon?.deviceIds.filter(id => id !== device.id))}>{device.name}</Checkbox>)}</div> : null}
          </div>
        })}
      </div>
      {contract ? <p role="status" className="!m-0 !rounded-[10px] !bg-[var(--crm-blue-soft)] !p-3 !text-sm !font-semibold">Total sin IVA: {billingMoney(contract.recurringCents)} / {plan.interval === 'month' ? 'mes' : 'año'} · {contract.limits.venues} locales · {contract.limits.devices} dispositivos</p> : <p role="alert" className="!text-sm !text-[var(--crm-red)]">Revisa las unidades, las asignaciones y las dependencias de los extras seleccionados.</p>}
    </> : null}
  </div>
}
