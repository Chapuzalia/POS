import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Checkbox } from '../../components/ui/Checkbox'
import { billingField, billingCard } from './TenantBillingPanel'
import { billingMoney, billingRequest } from './service'
import { centsToInput, parseMoneyToCents } from '../../lib/format'
import type { BillingCatalog, Product, Version } from './types'

type VersionInput = Omit<Version, 'id' | 'productKey' | 'stripePriceId' | 'published'>
const newProduct: Product = { key: '', kind: 'plan', name: '', description: '', scope: 'tenant', featureKey: null, resource: null, active: false, sortOrder: 0 }
const newVersion: VersionInput = { interval: 'month', amountCents: 0, features: [], limits: { venues: 1, devices: 0 }, included: {}, maximum: null, requires: [] }
const versionInput = (value: Version | undefined): VersionInput => value ? { interval: value.interval, amountCents: value.amountCents, features: value.features, limits: value.limits, included: value.included, maximum: value.maximum, requires: value.requires } : newVersion

export function BillingCatalogEditor({ catalog, onSaved, disabled = false, onBusyChange }: { catalog: BillingCatalog; onSaved: () => Promise<void>; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [product, setProduct] = useState<Product>(() => catalog.products.find(row => row.active && row.kind === 'plan') ?? catalog.products[0] ?? newProduct)
  const initialVersion = catalog.versions.find(row => row.productKey === product.key)
  const [version, setVersion] = useState<VersionInput>(() => versionInput(initialVersion))
  const [price, setPrice] = useState(() => centsToInput(initialVersion?.amountCents ?? 0))
  const [createVersion, setCreateVersion] = useState(!catalog.products.length)
  const [reason, setReason] = useState('Nueva versión comercial')
  const [pendingActions, setPendingActions] = useState(0)
  const saving = pendingActions > 0
  useEffect(() => {
    onBusyChange?.(saving)
    return () => onBusyChange?.(false)
  }, [saving, onBusyChange])
  const busy = disabled || saving
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const running = useRef(false)
  const exists = catalog.products.some(row => row.key === product.key)
  const visibleVersions = catalog.versions.filter(row => (!exists || row.productKey === product.key) && (showHistory || !row.published || catalog.versions.find(version => version.published && version.productKey === row.productKey && version.interval === row.interval)?.id === row.id))
  const identityLocked = catalog.versions.some(row => row.productKey === product.key)
  async function run(action: () => Promise<void>) {
    if (disabled || running.current) return
    running.current = true
    setPendingActions(count => count + 1); setError(''); setMessage('')
    try { await action(); await onSaved() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar el catálogo.') }
    finally { running.current = false; setPendingActions(count => count - 1) }
  }
  function selectProduct(key: string) {
    const selected = catalog.products.find(row => row.key === key)
    setProduct(selected ?? newProduct)
    const latest = catalog.versions.find(row => row.productKey === key)
    setVersion(versionInput(latest))
    setPrice(centsToInput(latest?.amountCents ?? 0))
    setCreateVersion(!selected)
    setMessage(''); setError('')
  }
  const integerInput = (label: string, value: number, update: (value: number) => void, max = 100000) => <label className="!grid !gap-2 !text-sm">{label}<Input className={billingField} type="number" min={0} max={max} value={value} disabled={busy} onChange={event => update(Number(event.target.value))} /></label>
  return <div className="!grid !gap-5">
    {error ? <p role="alert" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    {message ? <p role="status" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-green-soft)] !p-4">{message}</p> : null}
    <section className={billingCard}><h2 className="!mb-2 !text-lg !font-bold">Planes y precios</h2><p className="!mb-4 !text-sm !text-[var(--crm-text-muted)]">Selecciona un producto para editarlo o preparar una tarifa nueva. Los clientes actuales conservan su precio.</p><ol aria-label="Pasos para publicar una tarifa" className="!mb-5 !grid !list-none !gap-2 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-blue-soft)] !p-4 !text-sm sm:!grid-cols-2"><li><strong>1. Guarda el borrador</strong><br />Revisa precio, periodicidad y lo que incluye.</li><li><strong>2. Publica la tarifa</strong><br />Estará disponible para contratar desde la ficha del cliente.</li></ol>
      <label className="!grid !gap-2 !text-sm">Producto<select className={billingField} disabled={busy} value={exists ? product.key : ''} onChange={event => selectProduct(event.target.value)}><option value="">Crear producto</option>{catalog.products.map(row => <option key={row.key} value={row.key}>{row.name} · {row.kind === 'plan' ? 'Plan' : 'Addon'}{row.active ? '' : ' · Inactivo'}</option>)}</select></label>
      <form className="!mt-4 !grid !gap-4" onSubmit={event => { event.preventDefault(); void run(async () => {
        if (createVersion && (!/^[0-9]+([.,][0-9]{1,2})?$/.test(price) || parseMoneyToCents(price) > 100000000)) throw new Error('Introduce un precio entre 0 y 1.000.000 €, con un máximo de dos decimales.')
        await billingRequest({ action: 'catalog-save', product, version: createVersion ? { ...version, amountCents: parseMoneyToCents(price) } : null, reason })
        setCreateVersion(false)
        setMessage(createVersion ? 'Borrador guardado. Publica la tarifa en la tabla para poder contratarla.' : 'Producto actualizado. Las tarifas existentes se conservan.')
      }) }}>
        <div className="!grid !gap-4 sm:!grid-cols-2">
          <label className="!grid !gap-2 !text-sm">Nombre<Input className={billingField} required disabled={busy} value={product.name} maxLength={120} onChange={event => setProduct({ ...product, name: event.target.value })} /></label>
          <label className="!grid !gap-2 !text-sm">Tipo<select className={billingField} disabled={busy || exists} value={product.kind} onChange={event => setProduct({ ...product, kind: event.target.value === 'plan' ? 'plan' : 'addon' })}><option value="plan">Plan base</option><option value="addon">Complemento</option></select></label>
        </div>
        <details open={!exists}><summary className="!cursor-pointer !py-2 !text-sm !font-medium">Identidad y configuración del producto</summary><p className="!text-xs !text-[var(--crm-text-muted)]">La identidad se conserva al crear tarifas nuevas. El ámbito indica si se contrata por empresa, local o dispositivo.</p><div className="!mt-3 !grid !gap-4 sm:!grid-cols-2">
          <label className="!grid !gap-2 !text-sm">Identificador estable<Input className={billingField} required pattern="[a-z][a-z0-9_]{0,79}" disabled={busy || exists} value={product.key} onChange={event => setProduct({ ...product, key: event.target.value })} /></label>
          <label className="!grid !gap-2 !text-sm">Ámbito<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan'} value={product.scope} onChange={event => setProduct({ ...product, scope: event.target.value === 'venue' ? 'venue' : event.target.value === 'device' ? 'device' : 'tenant' })}><option value="tenant">Empresa</option><option value="venue">Local</option><option value="device">Dispositivo / capacidad</option></select></label>
          <label className="!grid !gap-2 !text-sm">Funcionalidad asociada<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan' || product.scope === 'device'} value={product.featureKey ?? ''} onChange={event => setProduct({ ...product, featureKey: event.target.value || null })}><option value="">Solo capacidad / ninguna</option>{catalog.features.filter(row => !row.is_core).map(row => <option key={row.key} value={row.key}>{row.name}</option>)}</select></label>
          <label className="!grid !gap-2 !text-sm">Capacidad adicional<select className={billingField} disabled={busy || identityLocked || product.kind === 'plan'} value={product.resource ?? ''} onChange={event => setProduct({ ...product, resource: event.target.value === 'venues' ? 'venues' : event.target.value === 'devices' ? 'devices' : null })}><option value="">Ninguna</option><option value="venues">Locales</option><option value="devices">Dispositivos</option></select></label>
          {integerInput('Orden', product.sortOrder, sortOrder => setProduct({ ...product, sortOrder }), 10000)}
        </div></details>
        <label className="!grid !gap-2 !text-sm">Descripción<textarea className={billingField} disabled={busy} maxLength={2000} value={product.description} onChange={event => setProduct({ ...product, description: event.target.value })} /></label>
        <Checkbox checked={product.active} disabled={busy} onChange={active => setProduct({ ...product, active })}>Disponible para nuevas contrataciones</Checkbox>
        <Checkbox checked={createVersion} disabled={busy || !exists} onChange={setCreateVersion}>Cambiar precio o condiciones (crear una tarifa nueva)</Checkbox>
        {createVersion ? <div className="!grid !gap-4 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-surface-soft)] !p-4">
          <div className="!grid !gap-4 sm:!grid-cols-2"><label className="!grid !gap-2 !text-sm">Periodicidad<select className={billingField} value={version.interval} disabled={busy} onChange={event => setVersion({ ...version, interval: event.target.value === 'year' ? 'year' : 'month' })}><option value="month">Mensual</option><option value="year">Anual</option></select></label><label className="!grid !gap-2 !text-sm">Precio sin impuestos (€)<Input className={billingField} required type="text" inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" maxLength={10} value={price} disabled={busy} onChange={event => setPrice(event.target.value)} /></label></div>
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
        <div><Button disabled={busy} type="submit">{createVersion ? 'Guardar borrador de tarifa' : 'Guardar producto'}</Button></div>
      </form>
    </section>
    <section className={billingCard}><div className="!mb-4 !flex !flex-wrap !items-center !justify-between !gap-3"><h3 className="!m-0 !font-semibold">Tarifas {exists ? `de ${product.name}` : 'del catálogo'}</h3><Checkbox disabled={busy} checked={showHistory} onChange={setShowHistory}>Mostrar tarifas anteriores</Checkbox></div><p className="!mb-4 !text-sm !text-[var(--crm-text-muted)]">Los borradores todavía no se pueden contratar. Publicar una tarifa no cambia ni cobra las suscripciones existentes.</p><div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr><th className="!p-2">Producto / versión</th><th>Importe</th><th>Periodo</th><th>Referencia técnica</th><th>Estado</th></tr></thead><tbody>{visibleVersions.map(row => <tr key={row.id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{catalog.products.find(product => product.key === row.productKey)?.name}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{row.id.slice(0, 8)}</span></td><td>{billingMoney(row.amountCents)}</td><td>{row.interval === 'month' ? 'Mes' : 'Año'}</td><td className="!max-w-48 !break-all !text-xs">{row.stripePriceId ? <details><summary className="!cursor-pointer !py-2">Ver referencia Stripe</summary><code>{row.stripePriceId}</code></details> : 'Sin publicar'}</td><td>{row.published ? 'Publicada' : <Button disabled={busy} onClick={() => void run(async () => { await billingRequest({ action: 'catalog-publish', versionId: row.id }); setMessage('Tarifa publicada. Ya se puede seleccionar desde la ficha del cliente.') })}>Publicar tarifa</Button>}</td></tr>)}</tbody></table></div>{!visibleVersions.length ? <p className="!py-6 !text-center !text-sm !text-[var(--crm-text-muted)]">Todavía no hay tarifas. Guarda el primer borrador arriba.</p> : null}</section>
  </div>
}
