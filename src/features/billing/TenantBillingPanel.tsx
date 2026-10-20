import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Checkbox } from '../../components/ui/Checkbox'
import { AppModal } from '../../components/ui/AppModal'
import { billingDate, billingMoney, billingRequest, openBillingUrl } from './service'
import type { BillingCatalog, BillingDetail, BillingOperation, CommercialException, Selection } from './types'

export const billingCard = '!rounded-[var(--crm-radius-lg)] !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)] !text-[var(--crm-text)]'
export const billingField = '!min-h-11 !w-full !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !bg-[var(--crm-input-bg)] !px-3 !py-2 !text-sm !text-[var(--crm-text)]'
const emptySelection: Selection = { planVersionId: '', addons: [] }

type Props = { tenantId: string; admin?: boolean; disabled?: boolean; onChanged?: () => void }
export function TenantBillingPanel({ tenantId, admin = false, disabled = false, onChanged }: Props) {
  const [detail, setDetail] = useState<BillingDetail | null>(null)
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [quote, setQuote] = useState<BillingOperation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('Cambio solicitado por el cliente')
  const [exception, setException] = useState<CommercialException | null>(null)
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const [loaded, commercial] = await Promise.all([
      billingRequest<BillingDetail>({ action: 'get', tenantId }),
      billingRequest<BillingCatalog>({ action: 'catalog' }),
    ])
    setDetail(loaded); setCatalog(commercial)
    setSelection(loaded.scheduledContract?.selection ?? loaded.account.billed_contract?.selection ?? loaded.account.contract?.selection ?? emptySelection)
    setException((loaded.scheduledContract ?? loaded.account.billed_contract ?? loaded.account.contract)?.exception ?? null)
  }, [tenantId])
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar la operación.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { if (!disabled) void run(refresh) }, [refresh, run, disabled])
  const locked = disabled || busy
  const financialContract = detail?.account.billed_contract ?? detail?.account.contract
  const published = catalog?.versions.filter(version => version.published) ?? []
  const retained = detail?.scheduledContract ?? detail?.account.billed_contract ?? detail?.account.contract
  const retainedIds = new Set([retained?.selection.planVersionId, ...(retained?.selection.addons.map(addon => addon.versionId) ?? [])])
  const versions = published.filter((version, index) => admin || retainedIds.has(version.id) || published.findIndex(row => row.productKey === version.productKey && row.interval === version.interval) === index)
  const plan = versions.find(version => version.id === selection.planVersionId)
  const availablePlans = versions.filter(version => catalog?.products.some(product => product.key === version.productKey && product.kind === 'plan' && (product.active || retainedIds.has(version.id))))
  const addons = catalog?.products.filter(product => product.kind === 'addon' && (product.active || retained?.selection.addons.some(addon => addon.key === product.key))) ?? []

  function changePlan(planVersionId: string) {
    const target = versions.find(version => version.id === planVersionId)
    setSelection(current => ({ planVersionId, addons: current.addons.map(addon => {
      const previous = versions.find(version => version.id === addon.versionId)
      if (previous?.interval === target?.interval) return addon
      const matching = versions.find(version => version.productKey === addon.key && version.interval === target?.interval)
      return matching ? { ...addon, versionId: matching.id } : addon
    }) }))
    setQuote(null)
  }

  async function requestQuote() {
    const requestedException = exception ?? ((detail?.scheduledContract ?? detail?.account.billed_contract ?? detail?.account.contract)?.exception?.promotions?.length ? { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason, promotions: [] } : null)
    setQuote(await billingRequest<BillingOperation>({ action: 'quote', tenantId, selection, exception: admin ? requestedException : null, reason }))
  }
  return <div className="!grid !gap-5 [&_button]:!min-h-11">
    <div className="!flex !flex-wrap !items-center !justify-between !gap-3">
      <div><h2 className="!m-0 !text-lg !font-bold">{admin ? detail?.tenant.name ?? 'Empresa' : 'Suscripción y facturas'}</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Entorno de pruebas de Stripe · Facturación de Alteil</p></div>
      <Button disabled={locked} onClick={() => void run(refresh)}>Actualizar</Button>
    </div>
    {error ? <p role="alert" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    {message ? <p role="status" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-green-soft)] !p-4">{message}</p> : null}
    {detail ? <>
      <section className={billingCard}>
        {detail.account.sync_error === 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE' ? <p role="status" className="!mb-4 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-yellow-soft)] !p-3 !text-sm">El cambio de tarifa ya está aplicado. La reducción de permisos se completará cuando terminen las cajas y comandas abiertas.</p> : null}
        <div className="!grid !gap-4 sm:!grid-cols-2 lg:!grid-cols-4">
          <div><p className="!text-xs !text-[var(--crm-text-muted)]">Plan</p><strong>{financialContract?.planName ?? 'Asignación manual'}</strong></div>
          <div><p className="!text-xs !text-[var(--crm-text-muted)]">Importe recurrente, sin impuestos</p><strong>{financialContract ? `${billingMoney(financialContract.recurringCents)} / ${financialContract.interval === 'month' ? 'mes' : 'año'}` : 'Sin contrato Stripe'}</strong></div>
          <div><p className="!text-xs !text-[var(--crm-text-muted)]">Estado / último pago</p><strong>{detail.account.status} / {detail.account.last_payment_status ?? '—'}</strong></div>
          <div><p className="!text-xs !text-[var(--crm-text-muted)]">Renovación</p><strong>{billingDate(detail.account.period_end)}{detail.account.cancel_at_period_end ? ' · Cancelación programada' : ''}</strong></div>
        </div>
        <p className="!mt-4 !text-sm">Locales: {detail.venues.length} / {detail.tenant.max_venues} · Dispositivos: {detail.devices.length} / {detail.tenant.max_devices}</p>
        {detail.account.source === 'manual' ? <p className="!text-sm !text-[var(--crm-text-muted)]">Se mantienen tus permisos actuales hasta confirmar la contratación y su pago.</p> : null}
        {detail.commercialState === 'grace' || detail.commercialState === 'restricted' ? <p role="status" className="!rounded-[var(--crm-radius-sm)] !bg-[var(--crm-yellow-soft)] !p-3">Hay una incidencia de facturación. La operativa y los datos del restaurante se conservan. Contacta con Alteil para regularizar el servicio.</p> : null}
        <div className="!mt-4 !flex !flex-wrap !gap-2">
          <Button disabled={locked || !detail.account.stripe_customer_id} onClick={() => void run(async () => { const portal = await billingRequest<{ url: string }>({ action: 'portal', tenantId }); openBillingUrl(portal.url) })}>Métodos de pago y datos de facturación</Button>
          {admin ? <Button disabled={locked || !detail.account.stripe_customer_id} onClick={() => void run(async () => { await billingRequest({ action: 'reconcile', tenantId }); await refresh(); onChanged?.() })}>Conciliar con Stripe</Button> : null}
        </div>
      </section>
      {detail.account.contract?.addons.length ? <section className={billingCard}>
        <h3 className="!mb-3 !font-semibold">Complementos contratados</h3>
        <div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr><th className="!p-2">Complemento</th><th>Cantidad</th><th>Incluida</th><th>Facturable</th><th>Asignación / uso</th></tr></thead><tbody>{detail.account.contract.addons.map(addon => <tr key={addon.key} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{catalog?.products.find(product => product.key === addon.key)?.name ?? addon.key}</td><td>{addon.quantity}</td><td>{addon.included}</td><td>{addon.billable}</td><td>{addon.scope === 'venue' ? addon.venueIds.map(id => detail.venues.find(venue => venue.id === id)?.name ?? id).join(', ') : addon.scope === 'device' ? `${addon.deviceIds.length} dispositivos asignados` : 'Empresa'}</td></tr>)}</tbody></table></div>
      </section> : null}
      <section className={billingCard}>
        <h3 className="!mb-4 !font-semibold">Configurar plan y complementos</h3>
        <label className="!grid !gap-2 !text-sm">Plan y tarifa<select aria-label="Plan y tarifa" className={billingField} disabled={locked} value={selection.planVersionId} onChange={event => changePlan(event.target.value)}><option value="">Selecciona una tarifa publicada</option>{availablePlans.map(version => <option key={version.id} value={version.id}>{catalog?.products.find(product => product.key === version.productKey)?.name} · {billingMoney(version.amountCents)} / {version.interval === 'month' ? 'mes' : 'año'} · {admin ? version.id.slice(0, 8) : retainedIds.has(version.id) ? 'Contratada' : 'Vigente'}</option>)}</select></label>
        {!availablePlans.length ? <p className="!mt-3 !text-sm !text-[var(--crm-text-muted)]">El catálogo está pendiente de configuración comercial por Superadmin.</p> : null}
        {plan ? <div className="!mt-4 !grid !gap-3">{addons.map(product => {
          const selected = selection.addons.find(addon => addon.key === product.key)
          const version = selected ? versions.find(item => item.id === selected.versionId) : versions.find(item => item.productKey === product.key && item.interval === plan.interval)
          if (!version) return null
          const update = (quantity: number, venueIds = selected?.venueIds ?? [], deviceIds = selected?.deviceIds ?? []) => {
            setSelection(current => ({ ...current, addons: [...current.addons.filter(addon => addon.key !== product.key), { key: product.key, versionId: version.id, quantity, venueIds, deviceIds }] })); setQuote(null)
          }
          return <div className="!rounded-[var(--crm-radius-md)] !border !border-[var(--crm-border)] !p-4" key={product.key}>
            <div className="!flex !flex-wrap !items-center !justify-between !gap-3"><div><strong className="!text-sm">{product.name}</strong><p className="!mt-1 !text-xs !text-[var(--crm-text-muted)]">{billingMoney(version.amountCents)} / {plan.interval === 'month' ? 'mes' : 'año'} · {plan.included[product.key] ?? 0} unidades incluidas · {product.scope === 'venue' ? 'por local' : product.scope === 'device' ? 'por dispositivo' : 'por empresa'}</p></div><label className="!grid !gap-1 !text-xs">Cantidad contratada<Input className={`${billingField} !w-24`} aria-label={`Cantidad de ${product.name}`} disabled={locked} type="number" min={0} max={version.maximum ?? (product.scope === 'tenant' && !product.resource ? 1 : 100000)} value={selected?.quantity ?? 0} onChange={event => update(Number(event.target.value))} /></label></div>
            {product.scope === 'venue' ? <div className="!mt-3 !flex !flex-wrap !gap-4">{detail.venues.filter(venue => venue.is_active).map(venue => <Checkbox key={venue.id} checked={selected?.venueIds.includes(venue.id) ?? false} disabled={locked || !selected?.quantity} onChange={checked => update(selected?.quantity ?? 0, checked ? [...(selected?.venueIds ?? []), venue.id] : (selected?.venueIds ?? []).filter(id => id !== venue.id))}>{venue.name}</Checkbox>)}</div> : null}
            {product.scope === 'device' ? <div className="!mt-3 !flex !flex-wrap !gap-4">{detail.devices.map(device => <Checkbox key={device.id} checked={selected?.deviceIds.includes(device.id) ?? false} disabled={locked || !selected?.quantity} onChange={checked => update(selected?.quantity ?? 0, [], checked ? [...(selected?.deviceIds ?? []), device.id] : (selected?.deviceIds ?? []).filter(id => id !== device.id))}>{device.name}</Checkbox>)}</div> : null}
          </div>
        })}</div> : null}
        {admin && catalog ? <ExceptionEditor catalog={catalog} selection={selection} value={exception} disabled={locked} onChange={value => { setException(value); setQuote(null) }} /> : null}
        <label className="!mt-4 !grid !gap-2 !text-sm">Motivo<Input className={billingField} value={reason} maxLength={500} disabled={locked} onChange={event => setReason(event.target.value)} /></label>
        <Button className="!mt-4" disabled={locked || !plan || !reason.trim()} onClick={() => void run(requestQuote)}>Ver importes antes de confirmar</Button>
        {admin ? <div className="!mt-4 !flex !flex-wrap !gap-2">{[false, true].map(immediate => <Button key={String(immediate)} disabled={locked || !detail.account.stripe_subscription_id} onClick={() => void run(async () => { setQuote(await billingRequest<BillingOperation>({ action: 'quote-cancel', tenantId, immediate, reason })) })}>{immediate ? 'Cancelar inmediatamente…' : 'Programar cancelación…'}</Button>)}</div> : null}
      </section>
      {admin ? <PromotionHistory detail={detail} catalog={catalog} /> : null}
      {admin ? <BillingSettings detail={detail} disabled={locked} onSave={action => void run(async () => { await action(); await refresh() })} /> : null}
      <section className={billingCard}><h3 className="!mb-3 !font-semibold">Facturas de suscripción</h3><p className="!mb-3 !text-xs !text-[var(--crm-text-muted)]">Circuito de Alteil; independiente de los tickets y facturas del restaurante.</p>{detail.invoices.length ? <div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr><th className="!p-2">Factura</th><th>Fecha</th><th>Estado</th><th>Importe</th><th>Documento</th></tr></thead><tbody>{detail.invoices.map(invoice => <tr key={invoice.stripe_invoice_id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{invoice.number ?? invoice.stripe_invoice_id}</td><td>{billingDate(invoice.created_at)}</td><td>{invoice.status}</td><td>{billingMoney(invoice.amount_due_cents)}</td><td>{invoice.hosted_invoice_url ? <a className="!text-[var(--crm-blue)] !underline" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">Abrir factura</a> : '—'}</td></tr>)}</tbody></table></div> : <p className="!text-sm !text-[var(--crm-text-muted)]">Todavía no hay facturas sincronizadas.</p>}</section>
      <section className={billingCard}><h3 className="!mb-3 !font-semibold">Historial de cambios e incidencias</h3><div className="!grid !gap-3">{detail.operations.map(operation => <div key={operation.id} className="!flex !flex-wrap !items-center !justify-between !gap-2 !border-b !border-[var(--crm-border)] !pb-3 !text-sm"><span>{billingDate(operation.created_at)} · {operation.kind} · {operation.status}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{operation.reason}</span></span>{operation.result?.url && operation.status === 'payment_pending' ? <Button disabled={locked} onClick={() => openBillingUrl(operation.result?.url ?? '')}>Continuar pago</Button> : null}{admin && operation.status === 'applying' ? <Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'retry-operation', tenantId, operationId: operation.id }); await refresh() })}>Recuperar operación</Button> : null}</div>)}{detail.audit.map(entry => <p key={entry.id} className="!m-0 !text-xs !text-[var(--crm-text-muted)]">{billingDate(entry.created_at)} · {entry.action} · {entry.reason} · {entry.actor_id ?? 'Sistema'}</p>)}</div></section>
    </> : !error ? <p role="status">Cargando facturación…</p> : null}
    {quote ? <AppModal label="Confirmar cambio de facturación" theme="crm" maxWidth={560} dismissDisabled={busy} onClose={() => setQuote(null)}><div className="!grid !gap-4 !p-6"><h3 className="!text-lg !font-bold">Revisar y confirmar</h3><p>Cargo previsto ahora: <strong>{billingMoney(quote.preview.amountDueCents)}</strong></p><p>Nuevo importe recurrente sin impuestos: <strong>{billingMoney(quote.preview.recurringCents)}</strong></p><p>Efectivo: {quote.timing === 'immediate' ? 'inmediato, sujeto a la condición de pago' : billingDate(quote.preview.effectiveAt)}</p>{quote.preview.promotions ? <PromotionQuote quote={quote} catalog={catalog} interval={plan?.interval ?? 'month'} /> : null}<p className="!text-sm !text-[var(--crm-text-muted)]">{quote.preview.details}</p><p className="!text-sm">La contratación sustituye los derechos comerciales anteriores por el plan y las asignaciones seleccionadas. Las ventas y los documentos existentes se conservan.</p><div className="!flex !flex-wrap !justify-end !gap-2"><Button disabled={busy} onClick={() => setQuote(null)}>Volver</Button><Button disabled={busy} onClick={() => void run(async () => { const result = await billingRequest<{ url?: string }>({ action: 'confirm', tenantId, operationId: quote.id }); setQuote(null); if (result.url) openBillingUrl(result.url); else { await refresh(); setMessage('Solicitud registrada. El estado y los permisos se actualizarán tras la confirmación de Stripe.'); onChanged?.() } })}>Confirmar en sandbox</Button></div></div></AppModal> : null}
  </div>
}

function ExceptionEditor({ catalog, selection, value, disabled, onChange }: { catalog: BillingCatalog; selection: Selection; value: CommercialException | null; disabled: boolean; onChange: (value: CommercialException | null) => void }) {
  return <details className="!mt-4"><summary className="!cursor-pointer !py-3 !text-sm !font-medium">Excepción comercial</summary>
    <Checkbox checked={value !== null} disabled={disabled} onChange={checked => onChange(checked ? { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason: '' } : null)}>Aplicar condiciones particulares</Checkbox>
    {value ? <div className="!mt-4 !grid !gap-4">
      <p className="!text-xs !text-[var(--crm-text-muted)]">Los ciclos de la excepción general comienzan en la próxima renovación. Las promociones por addon permiten inicio inmediato o en renovación, con fechas propias. No combines ambos tipos temporales.</p>
      <div className="!grid !gap-3 sm:!grid-cols-2"><label className="!grid !gap-2 !text-sm">Descuento (%)<Input className={billingField} type="number" min={0} max={100} step={0.01} disabled={disabled} value={value.discountBasisPoints / 100} onChange={event => onChange({ ...value, discountBasisPoints: Math.round(Number(event.target.value) * 100) })} /></label><label className="!grid !gap-2 !text-sm">Ciclos completos (vacío = permanente)<Input className={billingField} type="number" min={1} max={36} disabled={disabled} value={value.cycles ?? ''} onChange={event => onChange({ ...value, cycles: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      {(['venues','devices'] as const).map(resource => <label key={resource} className="!grid !gap-2 !text-sm">Límite especial de {resource === 'venues' ? 'locales' : 'dispositivos'}<Input className={billingField} type="number" min={0} disabled={disabled} value={value.limits[resource] ?? ''} placeholder="Según plan" onChange={event => { const limits = { ...value.limits }; if (event.target.value === '') delete limits[resource]; else limits[resource] = Number(event.target.value); onChange({ ...value, limits }) }} /></label>)}</div>
      <div className="!grid !gap-3 sm:!grid-cols-2">{catalog.products.filter(product => product.active).map(product => <div key={product.key} className="!grid !gap-2 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-3"><strong className="!text-sm">{product.name}</strong>{product.kind === 'addon' ? <label className="!grid !gap-1 !text-xs">Unidades gratuitas adicionales<Input className={billingField} type="number" min={0} disabled={disabled} value={value.freeUnits[product.key] ?? 0} onChange={event => onChange({ ...value, freeUnits: { ...value.freeUnits, [product.key]: Number(event.target.value) } })} /></label> : null}<label className="!grid !gap-1 !text-xs">Precio particular sin impuestos (céntimos)<Input className={billingField} type="number" min={0} disabled={disabled} value={value.customAmounts[product.key] ?? ''} placeholder="Tarifa general" onChange={event => { const customAmounts = { ...value.customAmounts }; if (event.target.value === '') delete customAmounts[product.key]; else customAmounts[product.key] = Number(event.target.value); onChange({ ...value, customAmounts }) }} /></label></div>)}</div>
      <div className="!grid !gap-3"><h4 className="!font-semibold">Promociones gratuitas por addon</h4><p className="!text-xs">Selecciona primero las cantidades y asignaciones contratadas. Meses = meses naturales desde la activación. Ciclos = periodos completos de la suscripción; con inicio inmediato también se regala el resto del periodo actual. Sin prorrateo al finalizar: primer cobro en la siguiente renovación.</p>
        {selection.addons.filter(addon => addon.quantity > 0).map(addon => {
          const promotion = value.promotions?.find(row => row.key === addon.key)
          const version = catalog.versions.find(row => row.id === addon.versionId)
          const edit = (patch: Partial<NonNullable<CommercialException['promotions']>[number]>) => {
            if (!promotion) return
            onChange({ ...value, promotions: value.promotions?.map(row => row.id === promotion.id ? { ...row, ...patch } : row) })
          }
          const persisted = Boolean(promotion?.consentRecordedAt)
          return <div key={addon.key} className="!grid !gap-3 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-3">
            <Checkbox disabled={disabled || Boolean(value.cycles)} checked={Boolean(promotion)} onChange={checked => onChange({ ...value, promotions: checked ? [...(value.promotions ?? []), { id: crypto.randomUUID(), key: addon.key, freeUnits: addon.quantity, start: 'immediate', durationUnit: 'months', duration: 3, consent: '' }] : (value.promotions ?? []).filter(row => row.key !== addon.key) })}>{catalog.products.find(product => product.key === addon.key)?.name ?? addon.key}</Checkbox>
            <p className="!text-xs">Precio habitual posterior: {billingMoney(value.customAmounts[addon.key] ?? version?.amountCents ?? 0)} por unidad / {version?.interval === 'year' ? 'año' : 'mes'}, antes de descuento general e impuestos.</p>
            {promotion ? <div className="!grid !gap-3 sm:!grid-cols-2">
              <label className="!grid !gap-1 !text-xs">Inicio<select className={billingField} disabled={disabled || persisted} value={promotion.start} onChange={event => edit({ start: event.target.value === 'immediate' ? 'immediate' : 'period_end' })}><option value="immediate">Inmediato</option><option value="period_end">Próxima renovación</option></select></label>
              <label className="!grid !gap-1 !text-xs">Unidad de duración<select className={billingField} disabled={disabled || persisted} value={promotion.durationUnit} onChange={event => edit({ durationUnit: event.target.value === 'months' ? 'months' : 'cycles' })}><option value="months">Meses naturales</option><option value="cycles">Ciclos completos de facturación</option></select></label>
              <label className="!grid !gap-1 !text-xs">Duración<Input className={billingField} disabled={disabled || persisted} type="number" min={1} max={36} value={promotion.duration} onChange={event => edit({ duration: Number(event.target.value) })} /></label>
              <label className="!grid !gap-1 !text-xs">Unidades gratuitas<Input className={billingField} disabled={disabled || persisted} type="number" min={1} max={addon.quantity} value={promotion.freeUnits} onChange={event => edit({ freeUnits: Number(event.target.value) })} /></label>
              <label className="!grid !gap-1 !text-xs sm:!col-span-2">Consentimiento del cliente para el cobro posterior (referencia, fecha y canal)<Input className={billingField} disabled={disabled || persisted} maxLength={500} value={promotion.consent} placeholder="Referencia del acuerdo comercial aceptado" onChange={event => edit({ consent: event.target.value })} /></label>
              {persisted ? <p className="!text-xs sm:!col-span-2">Acuerdo registrado: {billingDate(promotion.consentRecordedAt)}. Las fechas se conservan al cambiar plan o cantidades. Retirar la promoción recupera el precio en la próxima renovación.</p> : null}
            </div> : null}
          </div>
        })}
      </div>
      <label className="!grid !gap-2 !text-sm">Justificación de la excepción<Input className={billingField} disabled={disabled} maxLength={500} value={value.reason} onChange={event => onChange({ ...value, reason: event.target.value })} /></label>
    </div> : null}
  </details>
}

function BillingSettings({ detail, disabled, onSave }: { detail: BillingDetail; disabled: boolean; onSave: (action: () => Promise<void>) => void }) {
  const [graceDays, setGraceDays] = useState(detail.account.grace_days)
  const [legalName, setLegalName] = useState(detail.account.legal_name ?? '')
  const [taxId, setTaxId] = useState(detail.account.tax_id ?? '')
  const [email, setEmail] = useState(detail.account.email ?? '')
  const [reason, setReason] = useState('Configuración de la cuenta de facturación')
  return <details className={billingCard}><summary className="!cursor-pointer !py-2 !font-semibold">Datos de facturación y continuidad</summary><div className="!mt-4 !grid !gap-3 sm:!grid-cols-2">{[{ label: 'Razón social', value: legalName, set: setLegalName }, { label: 'NIF/CIF', value: taxId, set: setTaxId }, { label: 'Email de facturación', value: email, set: setEmail }, { label: 'Motivo', value: reason, set: setReason }].map(field => <label key={field.label} className="!grid !gap-2 !text-sm">{field.label}<Input className={billingField} disabled={disabled} value={field.value} onChange={event => field.set(event.target.value)} /></label>)}<label className="!grid !gap-2 !text-sm">Días de gracia<Input className={billingField} disabled={disabled} type="number" min={0} max={365} value={graceDays} onChange={event => setGraceDays(Number(event.target.value))} /></label></div><Button className="!mt-4" disabled={disabled || !reason.trim()} onClick={() => onSave(async () => { await billingRequest({ action: 'settings', tenantId: detail.account.tenant_id, graceDays, legalName, taxId, email, reason }) })}>Guardar datos</Button></details>
}

function PromotionQuote({ quote, catalog, interval }: { quote: BillingOperation; catalog: BillingCatalog | null; interval: 'month' | 'year' }) {
  return <div className="!grid !gap-3 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-3">
    <p>Cuota durante la promoción: <strong>{billingMoney(quote.preview.recurringCents)} / {interval === 'year' ? 'año' : 'mes'}</strong>, sin impuestos.</p>
    <p>Cuota tras todas las promociones: <strong>{billingMoney(quote.preview.afterPromotionCents ?? quote.preview.recurringCents)} / {interval === 'year' ? 'año' : 'mes'}</strong>, sin impuestos.</p>
    {quote.preview.promotions?.map(promotion => <div key={promotion.id} className="!grid !gap-1 !text-sm">
      <strong>{catalog?.products.find(p => p.key === promotion.key)?.name ?? promotion.key}: {promotion.freeUnits} unidades gratuitas</strong>
      <p>Activación: {billingDate(promotion.activationAt)} · Fin: {billingDate(promotion.endsAt)}</p>
      <p>Primer cobro habitual: {promotion.firstChargeAt ? billingDate(promotion.firstChargeAt) : 'Sin cargo adicional con el contrato seleccionado'} · Addon: {billingMoney(promotion.firstAddonChargeCents)} sin impuestos · Factura total estimada: {billingMoney(promotion.firstInvoiceCents)}. Sin prorrateo.</p>
    </div>)}
  </div>
}

function PromotionHistory({ detail, catalog }: { detail: BillingDetail; catalog: BillingCatalog | null }) {
  const records = new Map<string, { promotion: NonNullable<CommercialException['promotions']>[number]; operation: BillingOperation }>()
  for (const operation of detail.operations) {
    if (!['completed','scheduled','payment_pending','applying'].includes(operation.status)) continue
    for (const promotion of operation.contract?.exception?.promotions ?? []) if (!records.has(promotion.id)) records.set(promotion.id, { promotion, operation })
  }
  const current = (detail.account.billed_contract ?? detail.account.contract)?.exception?.promotions ?? []
  const scheduled = detail.operations.find(operation => operation.id === detail.account.schedule_operation_id)?.contract?.exception?.promotions ?? current
  const now = Date.now() / 1000
  return <section className={billingCard}><h3 className="!mb-3 !font-semibold">Promociones activas, futuras y finalizadas</h3><p className="!mb-3 !text-xs">Últimas 50 operaciones confirmadas. Los presupuestos sin confirmar no activan promociones.</p><div className="!grid !gap-3">{[...records.values()].map(({ promotion, operation }) => {
    const status = detail.account.status === 'canceled' ? 'Cancelada' : !scheduled.some(p => p.id === promotion.id) ? current.some(p => p.id === promotion.id) ? 'Retirada en próxima renovación' : 'Retirada' : (promotion.endsAt ?? 0) <= now ? 'Finalizada' : (promotion.startsAt ?? 0) > now ? 'Futura' : current.some(p => p.id === promotion.id) ? 'Activa' : operation.status === 'completed' ? 'Retirada' : 'Pendiente de confirmación de Stripe'
    return <div key={promotion.id} className="!border-b !border-[var(--crm-border)] !pb-3 !text-sm"><strong>{catalog?.products.find(p => p.key === promotion.key)?.name ?? promotion.key} · {status}</strong><p>{promotion.freeUnits} unidades · {billingDate(promotion.startsAt ? new Date(promotion.startsAt * 1000).toISOString() : null)} — {billingDate(promotion.endsAt ? new Date(promotion.endsAt * 1000).toISOString() : null)}</p><p>Justificación: {operation.contract?.exception?.reason}</p><p>Consentimiento: {promotion.consent} · Registrado: {billingDate(promotion.consentRecordedAt)}</p></div>
  })}{!records.size ? <p className="!text-sm">No hay promociones confirmadas en este historial.</p> : null}</div></section>
}
