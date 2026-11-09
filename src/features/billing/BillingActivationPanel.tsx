import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { AppModal } from '../../components/ui/AppModal'
import { Checkbox } from '../../components/ui/Checkbox'
import { Input } from '../../components/ui/Input'
import { BillingSelectionEditor } from './BillingSelectionEditor'
import { billingMoney, billingRequest, openBillingUrl } from './service'
import { buildContract } from './selection'
import type { BillingCatalog, BillingDetail, BillingOperation, Selection } from './types'

type Props = { tenantId: string; disabled?: boolean; onActivated: () => void }
export function BillingActivationPanel({ tenantId, disabled = false, onActivated }: Props) {
  const [detail, setDetail] = useState<BillingDetail | null>(null)
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null)
  const [editing, setEditing] = useState<Selection | null>(null)
  const [quote, setQuote] = useState<BillingOperation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The IBAN only travels to the billing function to create the Mollie mandate; it is never persisted here.
  const [sepa, setSepa] = useState({ legalName: '', taxId: '', accountHolder: '', iban: '', accepted: false })
  const [returnedFromCheckout] = useState(() => new URLSearchParams(window.location.search).get('billing') === 'success')
  const refresh = useCallback(async (reconcile = false) => {
    if (reconcile) await billingRequest({ action: 'reconcile', tenantId })
    const [next, products] = await Promise.all([
      billingRequest<BillingDetail>({ action: 'get', tenantId }),
      billingRequest<BillingCatalog>({ action: 'catalog' }),
    ])
    setDetail(next); setCatalog(products)
    if (next.tenant.billing_activation_required === false) onActivated()
    return next
  }, [tenantId, onActivated])
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar la operación. Vuelve a intentarlo.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => {
    if (!disabled) void run(async () => {
      const next = await refresh()
      if (returnedFromCheckout && next.tenant.billing_activation_required !== false && next.account.stripe_customer_id) await refresh(true)
    })
  }, [disabled, returnedFromCheckout, refresh, run])
  const customerId = detail?.account.stripe_customer_id
  useEffect(() => {
    if (disabled || !customerId || editing || quote || busy) return
    const timer = window.setInterval(() => { void run(() => refresh(true)) }, 10000)
    return () => window.clearInterval(timer)
  }, [disabled, customerId, editing, quote, busy, refresh, run])
  const pending = detail?.operations.find(operation => ['applying','payment_pending','scheduled'].includes(operation.status))
  const checkoutReady = pending?.status === 'payment_pending' && Boolean(pending.result?.url)
  const checkingPayment = pending?.status === 'payment_pending' && (returnedFromCheckout || detail?.account.last_payment_status === 'processing')
  const contract = pending?.contract ?? detail?.account.onboarding_contract
  const locked = disabled || busy
  let validSelection = false
  if (editing && catalog) {
    try { buildContract(catalog.products, catalog.versions, editing); validSelection = true } catch { /* Keep invalid selections editable, but never submit them. */ }
  }
  return <div className="!mx-auto !grid !w-full !max-w-3xl !gap-5">
    <section className="!grid !gap-5 !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)] sm:!p-7">
      <div><p className="!m-0 !text-sm !font-semibold !text-[var(--crm-blue)]">Pendiente de activación</p><h2 className="!mb-2 !mt-2 !text-2xl !font-bold">Tu negocio está casi listo</h2><p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">Revisa tu plan, domicilia las siguientes cuotas por SEPA y paga la primera con tarjeta en Mollie. El acceso se activará al confirmarse el pago con tarjeta.</p></div>
      {returnedFromCheckout && busy ? <p role="status" className="!m-0 !text-sm">Estamos comprobando automáticamente tu pago…</p> : null}
      {error ? <div role="alert" className="!rounded-xl !bg-[var(--crm-red-soft)] !p-4 !text-sm !text-[var(--crm-red)]">{error}</div> : null}
      {!detail || !catalog ? <><p role="status">{error ? 'El plan no está disponible en este momento.' : 'Cargando tu plan…'}</p><Button disabled={locked} onClick={() => void run(() => refresh())}>Reintentar</Button></> : editing ? <>
        <h3 className="!m-0 !text-lg !font-semibold">Modificar plan contratado</h3>
        <BillingSelectionEditor catalog={catalog} selection={editing} onChange={setEditing} disabled={locked} venues={detail.venues} devices={detail.devices} />
        <div className="!flex !flex-wrap !justify-end !gap-3"><Button disabled={locked} onClick={() => setEditing(null)}>Cancelar</Button><Button disabled={locked || !validSelection} onClick={() => void run(async () => {
          await billingRequest({ action: 'save-onboarding', tenantId, selection: editing })
          await refresh(); setEditing(null)
        })}>Guardar cambios</Button></div>
      </> : contract ? <>
        <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-5">
          <h3 className="!m-0 !text-xl !font-bold">{contract.planName}</h3>
          <p className="!m-0 !text-2xl !font-bold">{billingMoney(contract.recurringCents)} <span className="!text-sm !font-normal">/ {contract.interval === 'month' ? 'mes' : 'año'}, sin IVA</span></p>
          <p className="!m-0 !text-sm">{contract.limits.venues} {contract.limits.venues === 1 ? 'local' : 'locales'} · {contract.limits.devices} dispositivos</p>
          <div className="!border-t !border-[var(--crm-border)] !pt-3"><strong className="!text-sm">Extras seleccionados</strong>{contract.addons.some(addon => addon.quantity > 0) ? <ul className="!mb-0 !mt-2 !grid !gap-2 !pl-4 !text-sm">{contract.addons.filter(addon => addon.quantity > 0).map(addon => <li key={addon.key}>{catalog.products.find(product => product.key === addon.key)?.name ?? addon.key} · {addon.quantity} {addon.billable === 0 ? '· Incluido' : ''}</li>)}</ul> : <p className="!mb-0 !mt-2 !text-sm !text-[var(--crm-text-muted)]">Sin extras adicionales.</p>}</div>
        </div>
        {pending ? <p role={pending.status === 'applying' ? 'alert' : 'status'} className="!m-0 !text-sm">{checkingPayment
          ? 'Estamos comprobando tu pago. El acceso se activará cuando Mollie lo confirme.'
          : checkoutReady
            ? 'Tu página de pago está lista. Pulsa «Continuar pago en Mollie» para acceder a ella.'
            : 'La apertura de la página de pago no se ha completado. Pulsa «Comprobar estado»; si el intento sigue bloqueado, contacta con soporte para recuperarlo.'}</p> : null}
        <div className="!flex !flex-wrap !gap-3">
          <Button className="!rounded-[10px] !bg-[var(--crm-blue)] !px-5 !font-semibold !text-white" disabled={locked || Boolean(pending && (pending.status !== 'payment_pending' || !pending.result?.url))} onClick={() => void run(async () => {
            if (pending?.result?.url) { openBillingUrl(pending.result.url); return }
            setQuote(await billingRequest<BillingOperation>({ action: 'quote', tenantId, selection: contract.selection, exception: null, reason: 'Activación inicial del negocio' }))
          })}>{pending?.result?.url ? 'Continuar pago en Mollie' : 'Pagar con Mollie'}</Button>
          <Button disabled={locked || Boolean(pending && pending.status !== 'payment_pending')} onClick={() => void run(async () => {
            if (pending) await billingRequest({ action: 'restart-checkout', tenantId })
            const next = await refresh()
            const prepared = pending?.contract ?? next.account.onboarding_contract
            if (next.tenant.billing_activation_required && prepared) setEditing(prepared.selection)
          })}>Modificar plan contratado</Button>
          <Button disabled={locked} onClick={() => void run(() => refresh(Boolean(customerId)))}>Comprobar estado</Button>
        </div>
      </> : <p role="alert">No hay un plan preparado. Contacta con el administrador.</p>}
    </section>
    {quote ? <AppModal label="Revisar pago del plan" theme="crm" maxWidth={520} dismissDisabled={busy} onClose={() => setQuote(null)}><div className="!grid !gap-4 !p-6"><h3 className="!m-0 !text-lg !font-bold">Revisar pago</h3><p className="!m-0">{quote.contract?.planName}</p><p className="!m-0 !text-2xl !font-bold">{billingMoney(quote.preview.amountDueCents)} <span className="!text-sm !font-normal">IVA incluido</span></p><p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">Suscripción {quote.contract?.interval === 'year' ? 'anual' : 'mensual'}. Pagarás esta primera cuota con tarjeta en Mollie. Las siguientes se cargarán por domiciliación SEPA en esta cuenta.</p>
      <div className="!grid !gap-3">
        <label className="!grid !gap-1 !text-sm">Razón social<Input autoComplete="organization" value={sepa.legalName} disabled={locked} onChange={event => setSepa({ ...sepa, legalName: event.target.value })} /></label>
        <label className="!grid !gap-1 !text-sm">NIF/CIF<Input value={sepa.taxId} disabled={locked} onChange={event => setSepa({ ...sepa, taxId: event.target.value })} /></label>
        <label className="!grid !gap-1 !text-sm">Titular de la cuenta<Input autoComplete="name" value={sepa.accountHolder} disabled={locked} onChange={event => setSepa({ ...sepa, accountHolder: event.target.value })} /></label>
        <label className="!grid !gap-1 !text-sm">IBAN<Input autoComplete="off" inputMode="text" spellCheck={false} placeholder="ES00 0000 0000 0000 0000 0000" value={sepa.iban} disabled={locked} onChange={event => setSepa({ ...sepa, iban: event.target.value.toUpperCase() })} /></label>
        <Checkbox checked={sepa.accepted} disabled={locked} onChange={accepted => setSepa({ ...sepa, accepted })}>Autorizo a Alteil Solutions SL, a través de Mollie, a cargar en esta cuenta las cuotas recurrentes de Tickit mediante adeudo directo SEPA. Puedo solicitar la devolución en las condiciones de mi banco.</Checkbox>
      </div>{error ? <p role="alert" className="!text-sm !text-[var(--crm-red)]">{error}</p> : null}<div className="!flex !flex-wrap !justify-end !gap-3"><Button disabled={locked} onClick={() => setQuote(null)}>Volver</Button><Button disabled={locked || !sepa.accepted || !sepa.legalName.trim() || !sepa.taxId.trim() || sepa.accountHolder.trim().length < 2 || sepa.iban.replace(/\s/g, '').length < 15} onClick={() => void run(async () => {
      const result = await billingRequest<{ url?: string }>({ action: 'confirm', tenantId, operationId: quote.id, sepa: { accountHolder: sepa.accountHolder, iban: sepa.iban }, payer: { legalName: sepa.legalName, taxId: sepa.taxId } })
      if (result.url) openBillingUrl(result.url)
      else {
        const next = await refresh(Boolean(customerId))
        if (next.tenant.billing_activation_required) throw new Error('No se ha podido abrir la página de pago. Comprueba el estado o contacta con soporte para recuperar el intento.')
        setQuote(null)
      }
    })}>Domiciliar e ir al pago</Button></div></div></AppModal> : null}
  </div>
}
