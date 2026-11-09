import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Checkbox } from '../../components/ui/Checkbox'
import { DataTable } from '../../components/ui/DataTable'
import { SepaMandateFields } from './SepaMandateFields'
import { emptySepaForm, sepaConfirmInput, sepaFormReady } from './sepa'
import { AppModal } from '../../components/ui/AppModal'
import { billingDate, billingMoney, billingRequest, openBillingUrl } from './service'
import { parseMoneyToCents } from '../../lib/format'
import { billingAccountState, billingOperationLabel, billingPaymentInTransit, billingStateClass, billingStatusLabel } from './presentation'
import type { BillingCatalog, BillingDetail, BillingOperation, CommercialException, Selection } from './types'

export const billingCard = '!min-w-0 !rounded-[var(--crm-radius-lg)] !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)] !text-[var(--crm-text)]'
export const billingField = '!min-h-11 !w-full !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !bg-[var(--crm-input-bg)] !px-3 !py-2 !text-sm !text-[var(--crm-text)]'
const emptySelection: Selection = { planVersionId: '', addons: [] }

type Props = { tenantId: string; admin?: boolean; disabled?: boolean; onChanged?: () => void; onBusyChange?: (busy: boolean) => void }
export function TenantBillingPanel({ tenantId, admin = false, disabled = false, onChanged, onBusyChange }: Props) {
  const [detail, setDetail] = useState<BillingDetail | null>(null)
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [quote, setQuote] = useState<BillingOperation | null>(null)
  const [pendingActions, setPendingActions] = useState(0)
  const busy = pendingActions > 0
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])
  const [error, setError] = useState('')
  const [reason, setReason] = useState('Cambio solicitado por el cliente')
  const [exception, setException] = useState<CommercialException | null>(null)
  const [message, setMessage] = useState('')
  const [showHistoricalRates, setShowHistoricalRates] = useState(false)
  const [editingPlan, setEditingPlan] = useState(false)
  const [sepa, setSepa] = useState(emptySepaForm)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (!admin) headingRef.current?.focus() }, [admin, editingPlan])
  const refresh = useCallback(async () => {
    setQuote(null)
    const [loaded, commercial] = await Promise.all([
      billingRequest<BillingDetail>({ action: 'get', tenantId }),
      billingRequest<BillingCatalog>({ action: 'catalog' }),
    ])
    setDetail(loaded); setCatalog(commercial)
    setSelection(loaded.scheduledContract?.selection ?? loaded.account.billed_contract?.selection ?? loaded.account.contract?.selection ?? loaded.account.onboarding_contract?.selection ?? emptySelection)
    setException((loaded.scheduledContract ?? loaded.account.billed_contract ?? loaded.account.contract)?.exception ?? null)
  }, [tenantId])
  const run = useCallback(async (action: () => Promise<void>) => {
    setPendingActions(count => count + 1); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar la operación.') }
    finally { setPendingActions(count => count - 1) }
  }, [])
  useEffect(() => { if (!disabled) void run(refresh) }, [refresh, run, disabled])
  const locked = disabled || busy
  const accountState = detail ? billingAccountState(detail.account) : null
  const financialContract = detail?.account.billed_contract ?? detail?.account.contract ?? detail?.account.onboarding_contract
  const published = catalog?.versions.filter(version => version.published) ?? []
  const retained = detail?.scheduledContract ?? detail?.account.billed_contract ?? detail?.account.contract ?? detail?.account.onboarding_contract
  const hasSubscription = Boolean(detail?.account.stripe_subscription_id && ['active', 'trialing'].includes(detail.account.status))
  const temporaryGeneral = Boolean(financialContract?.exception?.cycles || retained?.exception?.cycles)
  const canPromote = hasSubscription && detail?.account.status === 'active' && Boolean(detail.account.billed_contract ?? detail.account.contract) && !temporaryGeneral
  const promotionNotice = temporaryGeneral
    ? 'El contrato tiene un descuento temporal por ciclos. Las promociones por complemento estarán disponibles cuando termine esa condición.'
    : 'Activa primero la suscripción. Después podrás añadir promociones a los complementos. Durante el alta puedes acordar un descuento o precio particular permanente.'
  // A first contract (no Mollie subscription yet) needs the SEPA mandate for the following renewals.
  const signupQuote = quote?.kind === 'change' && !detail?.account.stripe_subscription_id
  const pendingOperation = detail?.operations.find(operation => ['applying', 'payment_pending', 'scheduled'].includes(operation.status) && operation.id !== detail.account.schedule_operation_id)
  const subscriptionBlocked = Boolean(detail?.account.stripe_subscription_id && !['canceled', 'incomplete_expired'].includes(detail.account.status) && (!['active', 'trialing'].includes(detail.account.status) || detail.account.cancel_at_period_end))
  const exceptionError = exception && (!exception.reason.trim()
    ? 'Indica la justificación de las condiciones particulares.'
    : exception.promotions?.some(promotion => !promotion.consent.trim())
      ? 'Indica el consentimiento del cliente para el cobro posterior de cada promoción.'
      : exception.cycles && (!hasSubscription || exception.promotions?.length)
        ? 'Los ciclos temporales requieren una suscripción activa y no se combinan con promociones.'
        : exception.promotions?.length && !canPromote
          ? promotionNotice
          : '')
  const retainedIds = new Set([retained?.selection.planVersionId, ...(retained?.selection.addons.map(addon => addon.versionId) ?? [])])
  const versions = published.filter((version, index) => (admin && showHistoricalRates) || retainedIds.has(version.id) || published.findIndex(row => row.productKey === version.productKey && row.interval === version.interval) === index)
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
    const requestedException = exception ?? ((detail?.scheduledContract ?? detail?.account.billed_contract ?? detail?.account.contract ?? detail?.account.onboarding_contract)?.exception?.promotions?.length ? { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason, promotions: [] } : null)
    setQuote(await billingRequest<BillingOperation>({ action: 'quote', tenantId, selection, exception: admin ? requestedException : null, reason }))
  }
  function closePlanEditor() {
    setEditingPlan(false)
    setSelection(retained?.selection ?? emptySelection)
    setException(retained?.exception ?? null)
    setQuote(null)
    setError('')
  }

  const Editor = admin ? 'details' : 'section'
  const accountNotices = detail ? <>
    {accountState && (admin || accountState.needsAttention || detail.account.cancel_at_period_end || detail.account.status === 'canceled') ? <div className="!mb-5 !flex !flex-wrap !items-center !gap-3"><span className={`!rounded-full !px-3 !py-1.5 !text-sm !font-semibold ${billingStateClass[accountState.tone]}`}>{accountState.label}</span><p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">{accountState.description}</p></div> : null}
    {detail.account.sync_error === 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE' ? <p role="status" className="!mb-4 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-yellow-soft)] !p-3 !text-sm">El cambio de tarifa ya está aplicado. La reducción de permisos se completará cuando terminen las cajas y comandas abiertas.</p> : null}
    {billingPaymentInTransit(detail.account.last_payment_status) ? <p role="status" className="!mt-4 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-blue-soft)] !p-3 !text-sm">Domiciliación autorizada. Tu acceso está activo mientras el banco tramita el cobro. Podrás solicitar otro cambio cuando termine esta operación.</p> : null}
    {detail.account.source === 'manual' ? <p className="!text-sm !text-[var(--crm-text-muted)]">Se mantienen tus permisos actuales hasta confirmar el pago con tarjeta o verificar la autorización SEPA.</p> : null}
    {detail.commercialState === 'grace' || detail.commercialState === 'restricted' ? <p role="status" className="!rounded-[var(--crm-radius-sm)] !bg-[var(--crm-yellow-soft)] !p-3">Hay una incidencia de facturación. La operativa y los datos del restaurante se conservan. Contacta con Alteil para regularizar el servicio.</p> : null}
  </> : null
  return <div className="!grid !gap-5 [&_button]:!min-h-11">
    <div className={admin ? '!flex !flex-wrap !items-center !justify-between !gap-3' : '!grid !gap-3'}>
      {!admin && editingPlan ? <Button className="!w-fit !bg-transparent !px-0 !text-[var(--crm-text-secondary)] !shadow-none" disabled={locked} onClick={closePlanEditor}><span aria-hidden="true">←</span> Volver a mi plan</Button> : null}
      <div><h2 ref={headingRef} tabIndex={-1} className={`!m-0 !font-bold !text-[var(--crm-text)] !outline-none ${admin ? '!text-lg' : '!text-xl !tracking-tight'}`}>{admin ? detail?.tenant.name ?? 'Empresa' : editingPlan ? 'Modificar plan' : 'Mi plan'}</h2>{admin ? <p className="!mb-0 !mt-1 !text-sm !text-[var(--crm-text-muted)]">Configura su plan y condiciones comerciales. El cliente gestiona sus pagos y facturas desde su cuenta · Entorno de pruebas</p> : editingPlan ? <p className="!mb-0 !mt-2 !text-sm !text-[var(--crm-text-secondary)]">Elige tu plan y los complementos que necesitas. Después revisarás el importe.</p> : null}</div>
      {admin ? <Button disabled={locked} onClick={() => void run(refresh)}>Actualizar ficha</Button> : null}
    </div>
    {error ? <p role="alert" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    {message ? <p role="status" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-green-soft)] !p-4">{message}</p> : null}
    {detail ? <>
      {admin || !editingPlan ? <section aria-label="Resumen del plan" className={`${billingCard} ${!admin ? 'sm:!p-7' : ''}`}>
        {accountNotices}
        {admin ? <>
          <div className="!grid !gap-4 sm:!grid-cols-2 lg:!grid-cols-4">
            <div><p className="!text-xs !text-[var(--crm-text-muted)]">{detail.account.contract || detail.account.billed_contract ? 'Plan contratado' : 'Plan preparado'}</p><strong>{financialContract?.planName ?? 'Asignación manual'}</strong></div>
            <div><p className="!text-xs !text-[var(--crm-text-muted)]">Cuota sin IVA</p><strong>{financialContract ? `${billingMoney(financialContract.recurringCents)} / ${financialContract.interval === 'month' ? 'mes' : 'año'}` : 'Sin suscripción'}</strong></div>
            <div><p className="!text-xs !text-[var(--crm-text-muted)]">Último pago</p><strong>{billingStatusLabel(detail.account.last_payment_status)}</strong></div>
            <div><p className="!text-xs !text-[var(--crm-text-muted)]">Renovación</p><strong>{billingDate(detail.account.period_end)}{detail.account.cancel_at_period_end ? ' · Cancelación programada' : ''}</strong></div>
          </div>
          <p className="!mt-4 !text-sm">Locales: {detail.venues.length} / {detail.tenant.max_venues} · Dispositivos: {detail.devices.length} / {detail.tenant.max_devices}</p>
        </> : <>
          <div className="!flex !flex-col !gap-5 sm:!flex-row sm:!items-start sm:!justify-between">
            <div className="!min-w-0"><p className="!m-0 !mb-2 !text-sm !text-[var(--crm-text-secondary)]">{detail.account.contract || detail.account.billed_contract ? 'Plan contratado' : 'Plan preparado'}</p><h3 className="!m-0 !break-words !text-2xl !font-semibold !tracking-tight">{financialContract?.planName ?? 'Asignación manual'}</h3></div>
            {financialContract ? <div className="!shrink-0 sm:!text-right"><p className="!m-0 !flex !items-baseline !gap-2 sm:!justify-end"><strong className="!text-3xl !font-semibold !tabular-nums !tracking-tight">{billingMoney(financialContract.recurringCents)}</strong><span className="!text-sm !text-[var(--crm-text-secondary)]">/ {financialContract.interval === 'year' ? 'año' : 'mes'}</span></p><p className="!m-0 !mt-1 !text-xs !text-[var(--crm-text-secondary)]">Sin IVA</p></div> : null}
          </div>
          <div className="!mt-6 !border-t !border-[var(--crm-border)] !pt-5">
            <h4 className="!m-0 !mb-2 !text-sm !font-semibold">Complementos</h4>
            {financialContract?.addons.some(addon => addon.quantity > 0) ? <ul className="!m-0 !grid !list-none !divide-y !divide-[var(--crm-border-subtle)] !p-0">{financialContract.addons.filter(addon => addon.quantity > 0).map(addon => {
              const product = catalog?.products.find(product => product.key === addon.key)
              return <li key={addon.key} className="!flex !items-start !justify-between !gap-4 !py-3 !text-sm"><div className="!min-w-0"><span className="!font-medium">{product?.name ?? addon.key}</span>{product?.description ? <p className="!m-0 !mt-1 !text-xs !leading-relaxed !text-[var(--crm-text-secondary)]">{product.description}</p> : null}</div><span className="!shrink-0 !text-[var(--crm-text-secondary)]">{addon.quantity} {addon.quantity === 1 ? 'unidad' : 'unidades'}</span></li>
            })}</ul> : <p className="!mb-0 !mt-3 !text-sm !text-[var(--crm-text-secondary)]">Sin complementos adicionales</p>}
          </div>
        </>}
        <div className={admin ? '!mt-4 !flex !flex-wrap !gap-2' : '!mt-5 !flex !flex-col !gap-3 !border-t !border-[var(--crm-border)] !pt-5 sm:!flex-row sm:!justify-end'}>
          {!admin && ['past_due', 'unpaid'].includes(detail.account.status) ? <Button className="!w-full !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !bg-[var(--crm-surface-soft)] !text-[var(--crm-text)] sm:!w-auto" disabled={locked} onClick={() => void run(async () => { const portal = await billingRequest<{ url: string }>({ action: 'portal', tenantId }); openBillingUrl(portal.url) })}>Pagar cuota pendiente</Button> : null}
          {!admin ? <Button className="!w-full !rounded-[var(--crm-radius-sm)] sm:!w-auto" variant="primary" disabled={locked} onClick={() => setEditingPlan(true)}>Modificar plan</Button> : null}
          {admin ? <Button disabled={locked || !detail.account.stripe_customer_id} onClick={() => void run(async () => { await billingRequest({ action: 'reconcile', tenantId }); await refresh(); onChanged?.() })}>Actualizar estado con Mollie</Button> : null}
        </div>
      </section> : accountNotices}
      {pendingOperation ? <section aria-label="Siguiente paso" className={`${billingCard} !border !border-[var(--crm-border)]`}>
        <h3 className="!m-0 !text-base !font-semibold">{pendingOperation.status === 'scheduled' ? 'Cambio programado' : pendingOperation.status === 'applying' ? 'Hay una operación sin confirmar' : billingPaymentInTransit(detail.account.last_payment_status) ? 'El banco está tramitando el cobro' : admin ? 'Pago pendiente del cliente' : 'Completar el pago pendiente'}</h3>
        <p className="!mb-4 !mt-2 !text-sm !leading-relaxed !text-[var(--crm-text-muted)]">{pendingOperation.status === 'scheduled' ? `Se aplicará en la próxima renovación${pendingOperation.effective_at ? `: ${billingDate(pendingOperation.effective_at)}` : ''}. El contrato actual se mantiene hasta entonces.` : pendingOperation.status === 'applying' ? 'Comprueba el estado antes de continuar. Recuperar la operación reutiliza el mismo intento para evitar cargos duplicados.' : billingPaymentInTransit(detail.account.last_payment_status) ? 'La domiciliación está autorizada. No repitas el pago: espera la confirmación del banco.' : admin ? 'El cliente debe completar el pago desde su cuenta. Puedes actualizar el estado con Mollie para comprobar su avance.' : 'Continúa el intento existente para completar el pago. No es necesario volver a contratar el plan.'}</p>
        {pendingOperation.status === 'scheduled' && (admin || editingPlan) ? <>
          <div className="!mb-4 !grid !gap-3 sm:!grid-cols-2">
            {[{ label: 'Contrato actual', contract: financialContract }, { label: 'Contrato programado', contract: pendingOperation.contract }].map(({ label, contract }) => <div key={label} className="!min-w-0 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-4 !text-sm">
              <h4 className="!m-0 !mb-2 !font-semibold">{label}</h4>
              {contract ? <>
                <p className="!m-0">{contract.planName} · <strong>{billingMoney(contract.recurringCents)} / {contract.interval === 'year' ? 'año' : 'mes'}</strong> sin IVA</p>
                <p className="!mb-2 !mt-2">Hasta {contract.limits.venues} locales y {contract.limits.devices} dispositivos</p>
                {contract.addons.some(addon => addon.quantity > 0) ? <ul className="!m-0 !grid !list-none !gap-2 !p-0">{contract.addons.filter(addon => addon.quantity > 0).map(addon => <li key={addon.key}>
                  {catalog?.products.find(product => product.key === addon.key)?.name ?? addon.key}: {addon.quantity} · {addon.included} incluidas · {addon.billable} facturables
                  {addon.scope === 'venue' ? <span className="!block !text-xs !text-[var(--crm-text-muted)]">{addon.venueIds.map(id => detail.venues.find(venue => venue.id === id)?.name ?? 'Local no disponible').join(', ')}</span> : addon.scope === 'device' ? <span className="!block !text-xs !text-[var(--crm-text-muted)]">{addon.deviceIds.map(id => detail.devices.find(device => device.id === id)?.name ?? 'Dispositivo no disponible').join(', ')}</span> : null}
                </li>)}</ul> : <p className="!m-0 !text-[var(--crm-text-muted)]">Sin complementos adicionales</p>}
                {contract.exception?.discountBasisPoints ? <p className="!mb-0 !mt-2">Descuento: {contract.exception.discountBasisPoints / 100}%{contract.exception.cycles ? ` durante ${contract.exception.cycles} ciclos completos` : ' permanente'}</p> : null}
              </> : <p className="!m-0 !text-[var(--crm-text-muted)]">Detalle del contrato no disponible.</p>}
            </div>)}
          </div>
          <p className="!mb-4 !text-sm"><strong>Motivo:</strong> {pendingOperation.reason}</p>
        </> : null}
        <div className="!flex !flex-wrap !gap-2">
          {!admin && pendingOperation.status === 'payment_pending' && pendingOperation.result?.url && !billingPaymentInTransit(detail.account.last_payment_status) ? <Button variant="primary" disabled={locked} onClick={() => openBillingUrl(pendingOperation.result?.url ?? '')}>Continuar pago</Button> : null}
          {admin && pendingOperation.status === 'applying' ? <Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'retry-operation', tenantId, operationId: pendingOperation.id }); await refresh(); onChanged?.() })}>Recuperar operación</Button> : null}
        </div>
      </section> : null}
      {admin && detail.account.contract?.addons.length ? <details className={billingCard}>
        <summary className="!cursor-pointer !py-2 !font-semibold">Complementos contratados · {detail.account.contract.addons.filter(addon => addon.quantity > 0).length}</summary>
        <div className="!overflow-auto"><DataTable aria-label="Complementos contratados" className="!w-full !text-left !text-sm" filterable={false} sortable={false}><thead><tr><th className="!p-2">Complemento</th><th>Cantidad</th><th>Incluida</th><th>Facturable</th><th>Asignación / uso</th></tr></thead><tbody>{detail.account.contract.addons.map(addon => <tr key={addon.key} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{catalog?.products.find(product => product.key === addon.key)?.name ?? addon.key}</td><td>{addon.quantity}</td><td>{addon.included}</td><td>{addon.billable}</td><td>{addon.scope === 'venue' ? addon.venueIds.map(id => detail.venues.find(venue => venue.id === id)?.name ?? id).join(', ') : addon.scope === 'device' ? `${addon.deviceIds.length} dispositivos asignados` : 'Empresa'}</td></tr>)}</tbody></DataTable></div>
      </details> : null}
      {admin || editingPlan ? <Editor id={`billing-plan-editor-${tenantId}`} aria-label="Modificar plan y complementos" className={`${billingCard} ${!admin ? 'sm:!p-7' : ''}`} open={admin ? !financialContract : undefined}>
        {admin ? <summary className="!cursor-pointer !py-2 !text-base !font-semibold">{financialContract ? 'Cambiar plan y complementos' : 'Preparar una contratación'}</summary> : null}
        {admin ? <ol aria-label="Pasos para cambiar la suscripción" className="!mb-5 !mt-3 !flex !list-none !flex-wrap !gap-x-6 !gap-y-2 !p-0 !text-xs !text-[var(--crm-text-muted)]"><li>1. Elige el plan y los complementos</li><li>2. Revisa el importe y la fecha</li><li>3. Confirma el cambio</li></ol> : null}
        <label className="!grid !gap-2 !text-sm">Plan y tarifa<select aria-label="Plan y tarifa" className={billingField} disabled={locked} value={selection.planVersionId} onChange={event => changePlan(event.target.value)}><option value="">Selecciona una tarifa publicada</option>{availablePlans.map(version => <option key={version.id} value={version.id}>{catalog?.products.find(product => product.key === version.productKey)?.name}{!admin && retainedIds.has(version.id) ? ' (actual)' : ''} · {billingMoney(version.amountCents)} / {version.interval === 'month' ? 'mes' : 'año'}{admin ? ` · ${retainedIds.has(version.id) ? 'Contratada' : published.find(row => row.productKey === version.productKey && row.interval === version.interval)?.id === version.id ? 'Vigente' : 'Tarifa anterior'}` : ''}</option>)}</select></label>
        {!admin && plan ? <p className="!mb-0 !mt-3 !text-sm !leading-relaxed !text-[var(--crm-text-secondary)]">El plan incluye hasta {plan.limits.venues} locales y {plan.limits.devices} dispositivos.</p> : null}
        {!admin && plan && addons.length ? <h3 className="!mb-0 !mt-6 !text-base !font-semibold">Complementos</h3> : null}
        {admin ? <div className="!mt-3"><Checkbox disabled={locked} checked={showHistoricalRates} onChange={setShowHistoricalRates}>Mostrar tarifas anteriores</Checkbox></div> : null}
        {!availablePlans.length ? <p className="!mt-3 !text-sm !text-[var(--crm-text-muted)]">El catálogo está pendiente de configuración comercial por Superadmin.</p> : null}
        {plan ? <div className={admin ? '!mt-4 !grid !gap-3' : '!mt-1 !grid'}>{addons.map(product => {
          const selected = selection.addons.find(addon => addon.key === product.key)
          const version = selected ? versions.find(item => item.id === selected.versionId) : versions.find(item => item.productKey === product.key && item.interval === plan.interval)
          if (!version) return null
          const update = (quantity: number, venueIds = selected?.venueIds ?? [], deviceIds = selected?.deviceIds ?? []) => {
            setSelection(current => ({ ...current, addons: [...current.addons.filter(addon => addon.key !== product.key), ...(quantity > 0 ? [{ key: product.key, versionId: version.id, quantity, venueIds: venueIds.slice(0, quantity), deviceIds: deviceIds.slice(0, quantity) }] : [])] })); setQuote(null)
          }
          return <div className={admin ? '!rounded-[var(--crm-radius-md)] !border !border-[var(--crm-border)] !p-4' : '!border-b !border-[var(--crm-border-subtle)] !py-5'} key={product.key}>
            <div className="!flex !flex-wrap !items-center !justify-between !gap-3"><div><strong className="!text-sm">{product.name}</strong><p className="!mt-1 !text-xs !text-[var(--crm-text-muted)]">{billingMoney(version.amountCents)} / {plan.interval === 'month' ? 'mes' : 'año'} · {plan.included[product.key] ?? 0} unidades incluidas · {product.scope === 'venue' ? 'por local' : product.scope === 'device' ? 'por dispositivo' : 'por empresa'}</p></div>{product.scope === 'tenant' && !product.resource ? <Checkbox aria-label={product.name} disabled={locked} checked={Boolean(selected?.quantity)} onChange={checked => update(checked ? 1 : 0)}>{admin ? 'Añadir complemento' : selected?.quantity ? 'Añadido' : 'Añadir'}</Checkbox> : <label className="!grid !gap-1 !text-xs">Cantidad contratada<Input className={`${billingField} !w-24`} aria-label={`Cantidad de ${product.name}`} disabled={locked} type="number" min={0} max={version.maximum ?? 100000} value={selected?.quantity ?? 0} onChange={event => update(Number(event.target.value))} /></label>}</div>
            {product.scope === 'venue' ? <div className="!mt-3 !flex !flex-wrap !gap-4">{detail.venues.filter(venue => venue.is_active).map(venue => <Checkbox key={venue.id} checked={selected?.venueIds.includes(venue.id) ?? false} disabled={locked || !selected?.quantity} onChange={checked => update(selected?.quantity ?? 0, checked ? [...(selected?.venueIds ?? []), venue.id] : (selected?.venueIds ?? []).filter(id => id !== venue.id))}>{venue.name}</Checkbox>)}</div> : null}
            {product.scope === 'device' ? <div className="!mt-3 !flex !flex-wrap !gap-4">{detail.devices.map(device => <Checkbox key={device.id} checked={selected?.deviceIds.includes(device.id) ?? false} disabled={locked || !selected?.quantity} onChange={checked => update(selected?.quantity ?? 0, [], checked ? [...(selected?.deviceIds ?? []), device.id] : (selected?.deviceIds ?? []).filter(id => id !== device.id))}>{device.name}</Checkbox>)}</div> : null}
          </div>
        })}</div> : null}
        {admin && catalog ? <ExceptionEditor catalog={catalog} selection={selection} value={exception} disabled={locked} hasSubscription={hasSubscription} canPromote={canPromote} promotionNotice={promotionNotice} reason={reason} onChange={value => { setException(value); setQuote(null) }} /> : null}
        {admin ? <label className="!mt-4 !grid !gap-2 !text-sm">Motivo<Input className={billingField} value={reason} maxLength={500} disabled={locked} onChange={event => { setReason(event.target.value); setQuote(null) }} /></label> : null}
        {exceptionError ? <p role="status" className="!mt-3 !text-sm !text-[var(--crm-red)]">{exceptionError}</p> : null}
        {subscriptionBlocked && !pendingOperation ? <p role="status" className="!mt-3 !text-sm">Resuelve el pago pendiente o la baja programada antes de cambiar el plan. El método de pago se gestiona desde la cuenta del cliente.</p> : null}
        {pendingOperation ? <p role="status" className="!mt-3 !text-sm">{pendingOperation.status === 'scheduled' ? 'Hay un cambio programado para la próxima renovación. El contrato actual se mantiene hasta entonces.' : pendingOperation.status === 'payment_pending' ? admin ? 'Hay un pago pendiente. El cliente debe completarlo desde su cuenta.' : 'Hay un pago pendiente. Continúalo desde el aviso de pago.' : 'La última operación no está confirmada. Actualiza el estado con Stripe o recupérala desde el historial.'}</p> : null}
        <div className={admin ? '!mt-4' : '!mt-6 !flex !flex-col !gap-3 sm:!items-end'}>
          {!admin ? <p className="!m-0 !text-xs !leading-relaxed !text-[var(--crm-text-secondary)]">No se aplicará ningún cambio hasta que lo confirmes.</p> : null}
          <Button className={!admin ? '!w-full !rounded-[var(--crm-radius-sm)] sm:!w-auto' : undefined} variant="primary" disabled={locked || !plan || !reason.trim() || Boolean(exceptionError) || Boolean(pendingOperation) || subscriptionBlocked || billingPaymentInTransit(detail.account.last_payment_status)} onClick={() => void run(requestQuote)}>{admin ? 'Ver importes antes de confirmar' : 'Revisar cambio'}</Button>
        </div>
      </Editor> : null}
      {admin && detail.account.stripe_subscription_id ? <details className={`${billingCard} !border !border-[var(--crm-border)]`}><summary className="!cursor-pointer !py-2 !font-semibold !text-[var(--crm-red)]">Dar de baja la suscripción</summary><p className="!text-sm !text-[var(--crm-text-muted)]">Revisa primero cuándo termina el servicio. No se reembolsan periodos pagados.</p><div className="!mt-4 !flex !flex-wrap !gap-2">{[false, true].map(immediate => <Button key={String(immediate)} disabled={locked || !detail.account.stripe_subscription_id} onClick={() => void run(async () => { setQuote(await billingRequest<BillingOperation>({ action: 'quote-cancel', tenantId, immediate, reason })) })}>{immediate ? 'Revisar baja inmediata…' : 'Revisar baja al renovar…'}</Button>)}</div></details> : null}
      {admin ? <PromotionHistory detail={detail} catalog={catalog} /> : null}
      {admin ? <BillingSettings detail={detail} disabled={locked} onSave={action => void run(async () => { await action(); await refresh() })} /> : null}
      {!admin ? <section className={billingCard}><h3 className="!mb-3 !font-semibold">Facturas de suscripción</h3><p className="!mb-3 !text-xs !text-[var(--crm-text-muted)]">Circuito de Alteil; independiente de los tickets y facturas del restaurante.</p>{detail.invoices.length ? <div className="!overflow-auto"><DataTable aria-label="Facturas" className="!w-full !text-left !text-sm" filterable={false} sortable={false}><thead><tr><th className="!p-2">Factura</th><th>Fecha</th><th>Estado</th><th>Importe</th><th>Documento</th></tr></thead><tbody>{detail.invoices.map(invoice => <tr key={invoice.stripe_invoice_id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2">{invoice.number ?? invoice.stripe_invoice_id}</td><td>{billingDate(invoice.created_at)}</td><td>{billingStatusLabel(invoice.status)}</td><td>{billingMoney(invoice.amount_due_cents)}</td><td>{invoice.hosted_invoice_url ? <a className="!text-[var(--crm-blue)] !underline" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">Abrir factura</a> : '—'}</td></tr>)}</tbody></DataTable></div> : <p className="!text-sm !text-[var(--crm-text-muted)]">Todavía no hay facturas sincronizadas.</p>}</section> : null}
      {admin ? <>
      <details className={billingCard}><summary className="!cursor-pointer !py-2 !font-semibold">Historial de cambios · {detail.operations.length}</summary><div className="!grid !gap-3">{detail.operations.map(operation => <div key={operation.id} className="!flex !flex-wrap !items-center !justify-between !gap-2 !border-b !border-[var(--crm-border)] !pb-3 !text-sm"><span>{billingDate(operation.created_at)} · {billingOperationLabel(operation.kind)} · {billingStatusLabel(operation.status)}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{operation.reason}</span></span></div>)}{admin && detail.audit.length ? <details className="!mt-3"><summary className="!cursor-pointer !py-2 !text-xs !text-[var(--crm-text-muted)]">Auditoría técnica</summary>{detail.audit.map(entry => <p key={entry.id} className="!m-0 !text-xs !text-[var(--crm-text-muted)]">{billingDate(entry.created_at)} · {entry.action} · {entry.reason} · {entry.actor_id ?? 'Sistema'}</p>)}</details> : null}{!detail.operations.length ? <p className="!text-sm !text-[var(--crm-text-muted)]">Todavía no hay cambios registrados.</p> : null}</div></details>
      </> : null}
    </> : !error ? <p role="status">Cargando facturación…</p> : null}
    {quote ? <AppModal label="Confirmar cambio de facturación" theme="crm" maxWidth={560} dismissDisabled={locked} onClose={() => setQuote(null)}><div className="!grid !gap-4 !p-6"><h3 className="!m-0 !text-lg !font-bold">{quote.kind === 'cancel' || quote.kind === 'cancel_now' ? 'Revisar baja de la suscripción' : 'Revisar cambio de suscripción'}</h3><p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">{detail?.tenant.name}</p>{error ? <p role="alert" className="!text-sm !text-[var(--crm-red)]">{error}</p> : null}<p>Cargo previsto ahora: <strong>{billingMoney(quote.preview.amountDueCents)}</strong></p>{quote.kind !== 'cancel' && quote.kind !== 'cancel_now' ? <p>Nueva cuota sin IVA: <strong>{billingMoney(quote.preview.recurringCents)} / {plan?.interval === 'year' ? 'año' : 'mes'}</strong></p> : null}<p>Efectivo: {quote.timing === 'immediate' ? 'inmediato, sujeto a la condición de pago' : billingDate(quote.preview.effectiveAt)}</p>{quote.preview.promotions ? <PromotionQuote quote={quote} catalog={catalog} interval={plan?.interval ?? 'month'} /> : null}<p className="!text-sm !text-[var(--crm-text-muted)]">{quote.preview.details}</p>{signupQuote ? admin ? <p role="status" className="!text-sm">El propietario debe completar el alta desde Mi Plan, indicando el IBAN para domiciliar las siguientes cuotas.</p> : <SepaMandateFields value={sepa} disabled={locked} onChange={setSepa} /> : null}<p className="!text-sm">La contratación sustituye los derechos comerciales anteriores por el plan y las asignaciones seleccionadas. Las ventas y los documentos existentes se conservan.</p><div className="!flex !flex-wrap !justify-end !gap-2"><Button disabled={locked} onClick={() => setQuote(null)}>Volver</Button><Button variant={quote.kind === 'cancel' || quote.kind === 'cancel_now' ? 'danger' : 'primary'} disabled={locked || (signupQuote && (admin || !sepaFormReady(sepa)))} onClick={() => void run(async () => { const result = await billingRequest<{ url?: string }>({ action: 'confirm', tenantId, operationId: quote.id, ...(signupQuote ? sepaConfirmInput(sepa) : {}) }); setQuote(null); setEditingPlan(false); if (!admin && result.url) openBillingUrl(result.url); else { await refresh(); setMessage(admin && !detail?.account.stripe_subscription_id && quote.kind === 'change' ? 'Plan configurado. El cliente debe completar el pago desde su cuenta para activarlo.' : 'Solicitud registrada. El estado y los permisos se actualizarán tras la confirmación de Mollie.'); onChanged?.() } })}>{quote.kind === 'cancel' || quote.kind === 'cancel_now' ? 'Confirmar baja' : 'Confirmar cambio'}</Button></div></div></AppModal> : null}
  </div>
}

function ExceptionEditor({ catalog, selection, value, disabled, hasSubscription, canPromote, promotionNotice, reason, onChange }: { catalog: BillingCatalog; selection: Selection; value: CommercialException | null; disabled: boolean; hasSubscription: boolean; canPromote: boolean; promotionNotice: string; reason: string; onChange: (value: CommercialException | null) => void }) {
  return <details className="!mt-4"><summary className="!cursor-pointer !py-3 !text-sm !font-medium">Descuentos y condiciones especiales</summary>
    <Checkbox checked={value !== null} disabled={disabled} onChange={checked => onChange(checked ? { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason } : null)}>Aplicar condiciones particulares</Checkbox>
    {value ? <div className="!mt-4 !grid !gap-4">
      <p className="!text-xs !text-[var(--crm-text-muted)]">Los ciclos de la excepción general comienzan en la próxima renovación. Las promociones por addon permiten inicio inmediato o en renovación, con fechas propias. No combines ambos tipos temporales.</p>
      <div className="!grid !gap-3 sm:!grid-cols-2"><label className="!grid !gap-2 !text-sm">Descuento (%)<Input className={billingField} type="number" min={0} max={100} step={0.01} disabled={disabled} value={value.discountBasisPoints / 100} onChange={event => onChange({ ...value, discountBasisPoints: Math.round(Number(event.target.value) * 100) })} /></label><label className="!grid !gap-2 !text-sm">Ciclos completos (vacío = permanente)<Input className={billingField} type="number" min={1} max={36} disabled={disabled || !hasSubscription || Boolean(value.promotions?.length)} value={value.cycles ?? ''} onChange={event => onChange({ ...value, cycles: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      {(['venues','devices'] as const).map(resource => <label key={resource} className="!grid !gap-2 !text-sm">Límite especial de {resource === 'venues' ? 'locales' : 'dispositivos'}<Input className={billingField} type="number" min={0} disabled={disabled} value={value.limits[resource] ?? ''} placeholder="Según plan" onChange={event => { const limits = { ...value.limits }; if (event.target.value === '') delete limits[resource]; else limits[resource] = Number(event.target.value); onChange({ ...value, limits }) }} /></label>)}</div>
      <div className="!grid !gap-3 sm:!grid-cols-2">{catalog.products.filter(product => product.active).map(product => <div key={product.key} className="!grid !gap-2 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-3"><strong className="!text-sm">{product.name}</strong>{product.kind === 'addon' ? <label className="!grid !gap-1 !text-xs">Unidades gratuitas adicionales<Input className={billingField} type="number" min={0} disabled={disabled} value={value.freeUnits[product.key] ?? 0} onChange={event => onChange({ ...value, freeUnits: { ...value.freeUnits, [product.key]: Number(event.target.value) } })} /></label> : null}<label className="!grid !gap-1 !text-xs">Precio particular sin IVA (€)<Input className={billingField} type="number" min={0} max={1000000} step={0.01} disabled={disabled} value={value.customAmounts[product.key] === undefined ? '' : value.customAmounts[product.key] / 100} placeholder="Tarifa general" onChange={event => { const customAmounts = { ...value.customAmounts }; if (event.target.value === '') delete customAmounts[product.key]; else customAmounts[product.key] = parseMoneyToCents(event.target.value); onChange({ ...value, customAmounts }) }} /></label></div>)}</div>
      <div className="!grid !gap-3"><h4 className="!font-semibold">Promociones gratuitas por addon</h4>{!canPromote ? <p role="status" className="!text-sm">{promotionNotice}</p> : null}<p className="!text-xs">Selecciona primero las cantidades y asignaciones contratadas. Meses = meses naturales desde la activación. Ciclos = periodos completos de la suscripción; con inicio inmediato también se regala el resto del periodo actual. Sin prorrateo al finalizar: primer cobro en la siguiente renovación.</p>
        {selection.addons.filter(addon => addon.quantity > 0).map(addon => {
          const promotion = value.promotions?.find(row => row.key === addon.key)
          const version = catalog.versions.find(row => row.id === addon.versionId)
          const edit = (patch: Partial<NonNullable<CommercialException['promotions']>[number]>) => {
            if (!promotion) return
            onChange({ ...value, promotions: value.promotions?.map(row => row.id === promotion.id ? { ...row, ...patch } : row) })
          }
          const persisted = Boolean(promotion?.consentRecordedAt)
          return <div key={addon.key} className="!grid !gap-3 !rounded-[var(--crm-radius-sm)] !border !border-[var(--crm-border)] !p-3">
            <Checkbox disabled={disabled || Boolean(value.cycles) || (!canPromote && !promotion)} checked={Boolean(promotion)} onChange={checked => onChange({ ...value, promotions: checked ? [...(value.promotions ?? []), { id: crypto.randomUUID(), key: addon.key, freeUnits: addon.quantity, start: 'immediate', durationUnit: 'months', duration: 3, consent: '' }] : (value.promotions ?? []).filter(row => row.key !== addon.key) })}>{catalog.products.find(product => product.key === addon.key)?.name ?? addon.key}</Checkbox>
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
  return <details className={billingCard}><summary className="!cursor-pointer !py-2 !font-semibold">Promociones · {records.size} acuerdos registrados</summary><p className="!mb-3 !text-xs">Últimas 50 operaciones confirmadas. Los presupuestos sin confirmar no activan promociones.</p><div className="!grid !gap-3">{[...records.values()].map(({ promotion, operation }) => {
    const status = detail.account.status === 'canceled' ? 'Cancelada' : !scheduled.some(p => p.id === promotion.id) ? current.some(p => p.id === promotion.id) ? 'Retirada en próxima renovación' : 'Retirada' : (promotion.endsAt ?? 0) <= now ? 'Finalizada' : (promotion.startsAt ?? 0) > now ? 'Futura' : current.some(p => p.id === promotion.id) ? 'Activa' : operation.status === 'completed' ? 'Retirada' : 'Pendiente de confirmación de Stripe'
    return <div key={promotion.id} className="!border-b !border-[var(--crm-border)] !pb-3 !text-sm"><strong>{catalog?.products.find(p => p.key === promotion.key)?.name ?? promotion.key} · {status}</strong><p>{promotion.freeUnits} unidades · {billingDate(promotion.startsAt ? new Date(promotion.startsAt * 1000).toISOString() : null)} — {billingDate(promotion.endsAt ? new Date(promotion.endsAt * 1000).toISOString() : null)}</p><p>Justificación: {operation.contract?.exception?.reason}</p><p>Consentimiento: {promotion.consent} · Registrado: {billingDate(promotion.consentRecordedAt)}</p></div>
  })}{!records.size ? <p className="!text-sm">No hay promociones confirmadas en este historial.</p> : null}</div></details>
}
