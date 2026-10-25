import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Checkbox } from '../../components/ui/Checkbox'
import { billingField, billingCard } from './TenantBillingPanel'
import { billingMoney, billingRequest } from './service'
import type { BillingCatalog, Product, Version } from './types'

type VersionInput = Omit<Version, 'id' | 'productKey' | 'stripePriceId' | 'published'>
const newProduct: Product = { key: '', kind: 'plan', name: '', description: '', scope: 'tenant', featureKey: null, resource: null, active: false, sortOrder: 0 }
const newVersion: VersionInput = { interval: 'month', amountCents: 0, features: [], limits: { venues: 1, devices: 0 }, included: {}, maximum: null, requires: [] }

export function BillingCatalogEditor({ catalog, onSaved, disabled = false }: { catalog: BillingCatalog; onSaved: () => Promise<void>; disabled?: boolean }) {
  const [product, setProduct] = useState<Product>(newProduct)
  const [version, setVersion] = useState<VersionInput>(newVersion)
  const [createVersion, setCreateVersion] = useState(true)
  const [reason, setReason] = useState('Nueva versión comercial')
  const [saving, setBusy] = useState(false)
  const busy = disabled || saving
  const [error, setError] = useState('')
  const exists = catalog.products.some(row => row.key === product.key)
  const identityLocked = catalog.versions.some(row => row.productKey === product.key)
  async function run(action: () => Promise<void>) {
    if (disabled) return
    setBusy(true); setError('')
    try { await action(); await onSaved() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar el catálogo.') }
    finally { setBusy(false) }
  }
  function selectProduct(key: string) {
    const selected = catalog.products.find(row => row.key === key)
    setProduct(selected ?? newProduct)
    const latest = catalog.versions.find(row => row.productKey === key)
    setVersion(latest ? { interval: latest.interval, amountCents: latest.amountCents, features: latest.features, limits: latest.limits, included: latest.included, maximum: latest.maximum, requires: latest.requires } : newVersion)
    setCreateVersion(true)
  }
  const integerInput = (label: string, value: number, update: (value: number) => void, max = 100000) => <label className="!grid !gap-2 !text-sm">{label}<Input className={billingField} type="number" min={0} max={max} value={value} disabled={busy} onChange={event => update(Number(event.target.value))} /></label>
  return <div className="!grid !gap-5">
    {error ? <p role="alert" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    <section className={billingCard}><h2 className="!mb-4 !text-lg !font-bold">Planes y complementos</h2><p className="!mb-4 !text-sm !text-[var(--crm-text-muted)]">Cada tarifa nueva conserva las condiciones de los contratos anteriores. Publicar sincroniza el precio con Stripe sandbox.</p>
      <label className="!grid !gap-2 !text-sm">Producto<select className={billingField} disabled={busy} value={exists ? product.key : ''} onChange={event => selectProduct(event.target.value)}><option value="">Crear producto</option>{catalog.products.map(row => <option key={row.key} value={row.key}>{row.name} · {row.kind === 'plan' ? 'Plan' : 'Addon'}{row.active ? '' : ' · Inactivo'}</option>)}</select></label>
      <form className="!mt-4 !grid !gap-4" onSubmit={event => { event.preventDefault(); void run(async () => { await billingRequest({ action: 'catalog-save', product, version: createVersion ? version : null, reason }) }) }}>
        <div className="!grid !gap-4 sm:!grid-cols-2">
          <label className="!grid !gap-2 !text-sm">Identificador estable<Input className={billingField} required pattern="[a-z][a-z0-9_]{0,79}" disabled={busy || exists} value={product.key} onChange={event => setProduct({ ...product, key: event.target.value })} /></label>
          <label className="!grid !gap-2 !text-sm">Nombre<Input className={billingField} required disabled={busy} value={product.name} maxLength={120} onChange={event => setProduct({ ...product, name: event.target.value })} /></label>
          <label className="!grid !gap-2 !text-sm">Tipo<select className={billingField} disabled={busy || exists} value={product.kind} onChange={event => setProduct({ ...product, kind: event.target.value === 'plan' ? 'plan' : 'addon' })}><option value="plan">Plan base</option><option value="addon">Complemento</option></select></label>
          <label className="!grid !gap-2 !text-sm">Ámbito<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan'} value={product.scope} onChange={event => setProduct({ ...product, scope: event.target.value === 'venue' ? 'venue' : event.target.value === 'device' ? 'device' : 'tenant' })}><option value="tenant">Empresa</option><option value="venue">Local</option><option value="device">Dispositivo / capacidad</option></select></label>
          <label className="!grid !gap-2 !text-sm">Funcionalidad asociada<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan' || product.scope === 'device'} value={product.featureKey ?? ''} onChange={event => setProduct({ ...product, featureKey: event.target.value || null })}><option value="">Solo capacidad / ninguna</option>{catalog.features.filter(row => !row.is_core).map(row => <option key={row.key} value={row.key}>{row.name}</option>)}</select></label>
          <label className="!grid !gap-2 !text-sm">Capacidad adicional<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan'} value={product.resource ?? ''} onChange={event => setProduct({ ...product, resource: event.target.value === 'venues' ? 'venues' : event.target.value === 'devices' ? 'devices' : null })}><option value="">Ninguna</option><option value="venues">Locales</option><option value="devices">Dispositivos</option></select></label>
          {integerInput('Orden', product.sortOrder, sortOrder => setProduct({ ...product, sortOrder }), 10000)}
        </div>
        <label className="!grid !gap-2 !text-sm">Descripción<textarea className={billingField} disabled={busy} maxLength={2000} value={product.description} onChange={event => setProduct({ ...product, description: event.target.value })} /></label>
        <Checkbox checked={product.active} disabled={busy} onChange={active => setProduct({ ...product, active })}>Disponible para nuevas contrataciones</Checkbox>
        <Checkbox checked={createVersion} disabled={busy || !exists} onChange={setCreateVersion}>Crear nueva tarifa inmutable</Checkbox>
        {createVersion ? <div className="!grid !gap-4 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-surface-soft)] !p-4">
          <div className="!grid !gap-4 sm:!grid-cols-2"><label className="!grid !gap-2 !text-sm">Periodicidad<select className={billingField} value={version.interval} disabled={busy} onChange={event => setVersion({ ...version, interval: event.target.value === 'year' ? 'year' : 'month' })}><option value="month">Mensual</option><option value="year">Anual</option></select></label>{integerInput('Precio sin impuestos (céntimos de euro)', version.amountCents, amountCents => setVersion({ ...version, amountCents }), 100000000)}</div>
          {product.kind === 'plan' ? <>
            <div className="!grid !gap-4 sm:!grid-cols-2">{integerInput('Locales incluidos', version.limits.venues, venues => setVersion({ ...version, limits: { ...version.limits, venues } }))}{integerInput('Dispositivos incluidos', version.limits.devices, devices => setVersion({ ...version, limits: { ...version.limits, devices } }))}</div>
            <fieldset><legend className="!mb-3 !text-sm !font-semibold">Funcionalidades del plan</legend><div className="!flex !flex-wrap !gap-4">{catalog.features.filter(row => !row.is_core).map(feature => <Checkbox key={feature.key} checked={version.features.includes(feature.key)} disabled={busy} onChange={checked => setVersion({ ...version, features: checked ? [...version.features, feature.key] : version.features.filter(key => key !== feature.key) })}>{feature.name}</Checkbox>)}</div></fieldset>
            <fieldset><legend className="!mb-3 !text-sm !font-semibold">Unidades de complementos incluidas sin coste adicional</legend><div className="!grid !gap-3 sm:!grid-cols-2">{catalog.products.filter(row => row.kind === 'addon').map(addon => <div key={addon.key}>{integerInput(addon.name, version.included[addon.key] ?? 0, quantity => setVersion({ ...version, included: { ...version.included, [addon.key]: quantity } }))}</div>)}</div></fieldset>
          </> : <>
            <label className="!grid !gap-2 !text-sm">Máximo de unidades (vacío = sin máximo)<Input className={billingField} type="number" min={0} max={100000} disabled={busy} value={version.maximum ?? ''} onChange={event => setVersion({ ...version, maximum: event.target.value === '' ? null : Number(event.target.value) })} /></label>
            <fieldset><legend className="!mb-3 !text-sm !font-semibold">Funcionalidades requeridas</legend><div className="!flex !flex-wrap !gap-4">{catalog.features.filter(row => !row.is_core && row.key !== product.featureKey).map(feature => <Checkbox key={feature.key} disabled={busy} checked={version.requires.includes(feature.key)} onChange={checked => setVersion({ ...version, requires: checked ? [...version.requires, feature.key] : version.requires.filter(key => key !== feature.key) })}>{feature.name}</Checkbox>)}</div></fieldset>
          </>}
        </div> : null}
        <label className="!grid !gap-2 !text-sm">Motivo del cambio<Input className={billingField} required maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <div><Button disabled={busy} type="submit">Guardar catálogo</Button></div>
      </form>
    </section>
    <section className={billingCard}><h3 className="!mb-4 !font-semibold">Tarifas y correspondencia con Stripe</h3><div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr><th className="!p-2">Producto / versión</th><th>Importe</th><th>Periodo</th><th>Precio Stripe</th><th>Estado</th></tr></thead><tbody>{catalog.versions.map(row => <tr key={row.id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{catalog.products.find(product => product.key === row.productKey)?.name}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{row.id.slice(0, 8)}</span></td><td>{billingMoney(row.amountCents)}</td><td>{row.interval === 'month' ? 'Mes' : 'Año'}</td><td className="!max-w-48 !break-all !text-xs">{row.stripePriceId ?? '—'}</td><td>{row.published ? 'Publicada' : <Button disabled={busy} onClick={() => void run(async () => { await billingRequest({ action: 'catalog-publish', versionId: row.id }) })}>Publicar en sandbox</Button>}</td></tr>)}</tbody></table></div></section>
  </div>
}
