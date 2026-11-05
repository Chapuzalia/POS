import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { DataTable } from '../../components/ui/DataTable'
import { Input } from '../../components/ui/Input'
import { BillingCatalogEditor } from './BillingCatalogEditor'
import { TenantBillingPanel, billingCard, billingField } from './TenantBillingPanel'
import { billingDate, billingMoney, billingRequest } from './service'
import { billingAccountState, billingStateClass, billingStatusLabel } from './presentation'
import type { BillingCatalog, BillingOverview } from './types'

export default function BillingAdmin({ disabled, onBusyChange }: { disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [section, setSection] = useState<'dashboard' | 'clients' | 'catalog' | 'monitor'>('clients')
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    heading.current?.scrollIntoView({ block: 'start' })
  }, [section, tenantId])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingActions, setPendingActions] = useState(0)
  const busy = pendingActions > 0
  const [childBusy, setChildBusy] = useState(false)
  useEffect(() => {
    onBusyChange?.(busy || childBusy)
    return () => onBusyChange?.(false)
  }, [busy, childBusy, onBusyChange])
  const refresh = useCallback(async () => {
    const [next, commercial] = await Promise.all([billingRequest<BillingOverview>({ action: 'overview' }), billingRequest<BillingCatalog>({ action: 'catalog' })])
    setOverview(next); setCatalog(commercial)
  }, [])
  const run = useCallback(async (action: () => Promise<void>) => {
    setPendingActions(count => count + 1); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo cargar la facturación.') }
    finally { setPendingActions(count => count - 1) }
  }, [])
  useEffect(() => { if (!disabled) void run(refresh) }, [disabled, refresh, run])
  const locked = disabled || busy || childBusy
  const accounts = overview?.accounts ?? []
  const attentionCount = accounts.filter(account => billingAccountState(account).needsAttention).length
  const filtered = accounts.filter(account => `${account.name} ${account.tax_id ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (!status || account.status === status) && (!attentionOnly || billingAccountState(account).needsAttention))
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const distribution = new Map<string, number>()
  for (const account of accounts) if (account.contract && ['active','past_due','trialing'].includes(account.status)) distribution.set(account.contract.planName, (distribution.get(account.contract.planName) ?? 0) + 1)
  const openClient = (id: string) => { setSection('clients'); setTenantId(id) }
  return <div className="!grid !min-w-0 !grid-cols-[minmax(0,1fr)] !gap-6 [&_button]:!min-h-11 [&_.button--tertiary]:!bg-[var(--crm-surface-soft)] [&_.button--tertiary]:!text-[var(--crm-text)]">
    <header className="!flex !flex-wrap !items-start !justify-between !gap-4">
      <div><h2 ref={heading} tabIndex={-1} className="!m-0 !text-2xl !font-bold !tracking-tight !outline-none">Facturación</h2><p className="!mb-0 !mt-2 !text-sm !text-[var(--crm-text-muted)]">Clientes, suscripciones y cobros. Stripe está en modo de pruebas.</p></div>
      <Button disabled={locked} onClick={() => void run(refresh)}>{busy ? 'Actualizando…' : 'Actualizar lista'}</Button>
    </header>
    <nav aria-label="Áreas de facturación" className="!flex !flex-wrap !gap-2 !border-b !border-[var(--crm-border)] !pb-4">{([
      ['clients', 'Clientes'], ['catalog', 'Planes y precios'], ['dashboard', 'Resumen económico'], ['monitor', 'Diagnóstico'],
    ] as const).map(([key, label]) => <Button key={key} variant={section === key ? 'primary' : 'tertiary'} aria-pressed={section === key} disabled={locked} onClick={() => { setSection(key); setTenantId(null) }}>{label}</Button>)}</nav>
    {error ? <p role="alert" className="!m-0 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    {message ? <p role="status" className="!m-0 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-blue-soft)] !p-4 !text-sm">{message}</p> : null}
    {overview?.truncated ? <p role="status" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-yellow-soft)] !p-4">Los datos auxiliares alcanzaron el límite de consulta. El ingreso recurrente incluye todas las cuentas; los cobros y locales necesitan una consulta adicional.</p> : null}
    {section === 'clients' ? tenantId ? <>
      <div><Button disabled={locked} onClick={() => setTenantId(null)}>← Volver a clientes</Button></div>
      <TenantBillingPanel key={tenantId} tenantId={tenantId} admin disabled={disabled} onBusyChange={setChildBusy} onChanged={() => void run(refresh)} />
    </> : <section className={billingCard}>
      <div className="!mb-5 !flex !flex-wrap !items-start !justify-between !gap-4"><div><h2 className="!m-0 !text-lg !font-semibold">Clientes</h2><p className="!mb-0 !mt-1 !text-sm !text-[var(--crm-text-muted)]">Abre una ficha para gestionar el plan, resolver un pago o consultar facturas.</p></div><div className="!flex !flex-wrap !gap-2"><Button variant={!attentionOnly ? 'primary' : 'tertiary'} aria-pressed={!attentionOnly} disabled={locked} onClick={() => setAttentionOnly(false)}>Todos ({accounts.length})</Button><Button variant={attentionOnly ? 'primary' : 'tertiary'} aria-pressed={attentionOnly} disabled={locked} onClick={() => setAttentionOnly(true)}>Necesitan atención ({attentionCount})</Button></div></div>
      <div className="!mb-5 !grid !gap-3 sm:!grid-cols-[1fr_240px]"><Input className={billingField} aria-label="Buscar empresa o NIF" placeholder="Buscar empresa o NIF…" value={search} onChange={event => setSearch(event.target.value)} /><select className={billingField} aria-label="Filtrar estado de suscripción" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos los estados</option>{[...new Set(accounts.map(row => row.status))].map(value => <option key={value} value={value}>{billingStatusLabel(value)}</option>)}</select></div>
      <div className="!overflow-auto"><table className="!block !w-full !text-left !text-sm md:!table md:!min-w-[720px]"><thead className="!hidden md:!table-header-group !text-xs !text-[var(--crm-text-muted)]"><tr>{['Cliente','Plan y cuota sin IVA','Estado','Renovación',''].map((label, index) => <th className="!px-3 !py-3 !font-medium" key={index} scope="col">{label}</th>)}</tr></thead><tbody className="!block md:!table-row-group">{filtered.map(account => {
        const state = billingAccountState(account)
        const agreement = account.billed_contract ?? account.contract ?? account.onboarding_contract
        return <tr className="!grid !grid-cols-2 !gap-3 !border-t !border-[var(--crm-border)] !py-5 md:!table-row md:!p-0" key={account.tenant_id}>
          <td className="!order-1 !col-span-2 !px-0 !py-1 md:!px-3 md:!py-5"><strong>{account.name}</strong><p className="!mb-0 !mt-1 !text-xs !text-[var(--crm-text-muted)]">{account.tax_id ?? 'Sin NIF registrado'} · {account.venueCount ?? 0} {(account.venueCount ?? 0) === 1 ? 'local' : 'locales'}</p></td>
          <td className="!order-3 !px-0 !py-1 md:!px-3 md:!py-5"><span className="!mb-1 !block !text-xs !text-[var(--crm-text-muted)] md:!hidden">Plan y cuota sin IVA</span><strong className="!font-medium">{agreement?.planName ?? 'Sin plan Stripe'}</strong><p className="!mb-0 !mt-1 !text-xs !text-[var(--crm-text-muted)]">{agreement ? `${billingMoney(agreement.recurringCents)} / ${agreement.interval === 'month' ? 'mes' : 'año'}${!account.contract && !account.billed_contract ? ' · Preparado' : ''}` : 'Gestión manual'}</p></td>
          <td className="!order-2 !col-span-2 !px-0 !py-1 md:!max-w-72 md:!px-3 md:!py-5"><span className={`!inline-flex !rounded-full !px-2.5 !py-1 !text-xs !font-semibold ${billingStateClass[state.tone]}`}>{state.label}</span><p className="!mb-0 !mt-2 !text-xs !leading-relaxed !text-[var(--crm-text-muted)]">{state.description}</p></td>
          <td className="!order-4 !whitespace-nowrap !px-0 !py-1 md:!px-3 md:!py-5"><span className="!mb-1 !block !text-xs !text-[var(--crm-text-muted)] md:!hidden">Renovación</span>{billingDate(account.period_end)}</td>
          <td className="!order-5 !col-span-2 !px-0 !py-1 !text-right md:!px-3 md:!py-5"><Button className="!w-full md:!w-auto" aria-label={`Gestionar ${account.name}`} disabled={locked} onClick={() => openClient(account.tenant_id)}>Gestionar →</Button></td>
        </tr>
      })}</tbody></table></div>
      {overview && !filtered.length ? <div role="status" className="!py-12 !text-center"><p className="!font-semibold">{accounts.length ? 'No hay clientes con estos filtros' : 'Todavía no hay clientes'}</p><p className="!text-sm !text-[var(--crm-text-muted)]">{accounts.length ? 'Prueba otro nombre o muestra todos los estados.' : 'Los negocios creados desde Superadmin aparecerán aquí.'}</p>{accounts.length ? <Button onClick={() => { setSearch(''); setStatus(''); setAttentionOnly(false) }}>Limpiar filtros</Button> : null}</div> : null}
    </section> : null}
    {section === 'catalog' && catalog ? <BillingCatalogEditor catalog={catalog} onSaved={refresh} disabled={disabled} onBusyChange={setChildBusy} /> : null}
    {section === 'dashboard' && overview ? <>
      <div><h2 className="!m-0 !text-lg !font-semibold">Resumen económico</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Cuotas contratadas y facturas pagadas. Los ingresos recurrentes se muestran sin IVA.</p></div>
      <div className="!grid !gap-4 sm:!grid-cols-2 lg:!grid-cols-4">{[
        ['Ingreso mensual recurrente', billingMoney(overview.metrics.mrrCents)], ['Ingreso anual recurrente', billingMoney(overview.metrics.arrCents)],
        ['Cobrado este mes, con IVA', billingMoney(overview.metrics.paidCents)], ['Cobrado este mes, sin IVA', billingMoney(overview.metrics.paidExcludingTaxCents)],
        ['Suscripciones activas', accounts.filter(row => row.status === 'active').length], ['En prueba', accounts.filter(row => row.status === 'trialing').length],
        ['Pendientes de pago', accounts.filter(row => ['past_due','unpaid','incomplete'].includes(row.status)).length], ['Canceladas', accounts.filter(row => row.status === 'canceled').length],
        ['Altas este mes', accounts.filter(row => row.subscription_started_at && Date.parse(row.subscription_started_at) >= startOfMonth).length],
        ['Bajas este mes', accounts.filter(row => row.canceled_at && Date.parse(row.canceled_at) >= startOfMonth).length],
      ].map(([label, value]) => <article className={billingCard} key={label}><p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">{label}</p><strong className="!mt-3 !block !text-2xl">{value}</strong></article>)}</div>
      <section className={billingCard}><h3 className="!mb-3 !font-semibold">Suscripciones por plan</h3>{[...distribution].map(([name, count]) => <p className="!my-2 !text-sm" key={name}>{name}: <strong>{count}</strong></p>)}<p className="!mb-0 !mt-4 !text-xs !leading-relaxed !text-[var(--crm-text-muted)]">El ingreso recurrente incluye contratos activos y en mora; excluye pruebas, impuestos y prorrateos. Los cobros proceden de facturas pagadas y no representan liquidaciones bancarias.</p></section>
    </> : null}
    {section === 'monitor' && overview ? <>
      <section className={billingCard}><div className="!mb-5 !flex !flex-wrap !items-start !justify-between !gap-4"><div><h2 className="!m-0 !text-lg !font-semibold">Comprobar con Stripe</h2><p className="!mb-0 !mt-2 !text-sm !text-[var(--crm-text-muted)]">Actualiza estados cuando un pago o cambio no aparezca todavía. Se comprueban hasta 20 cuentas por intento.</p></div><Button disabled={locked} onClick={() => void run(async () => {
        const result = await billingRequest<{ results: Array<{ ok: boolean }> }>({ action: 'reconcile-batch' })
        await refresh()
        const failed = result.results.filter(row => !row.ok).length
        setMessage(`${result.results.length - failed} cuentas actualizadas.${failed ? ` ${failed} no se han podido comprobar; revisa su ficha antes de reintentar.` : ' No se han creado cargos nuevos.'}`)
      })}>Actualizar estados con Stripe</Button></div>
        {accounts.filter(account => account.stripe_customer_id).map(account => <div key={account.tenant_id} className="!flex !flex-wrap !items-center !justify-between !gap-3 !border-t !border-[var(--crm-border)] !py-4 !text-sm"><div><strong>{account.name}</strong><p className="!mb-0 !mt-1 !text-xs !text-[var(--crm-text-muted)]">Última comprobación: {billingDate(account.last_reconciled_at)} · {billingAccountState(account).label}</p></div><Button disabled={locked} onClick={() => openClient(account.tenant_id)}>Revisar cliente</Button></div>)}
        {!accounts.some(account => account.stripe_customer_id) ? <p className="!text-sm !text-[var(--crm-text-muted)]">No hay cuentas enlazadas con Stripe que comprobar.</p> : null}
      </section>
      <details className={billingCard}><summary className="!cursor-pointer !py-2 !font-semibold">Registro técnico de Stripe · {overview.events.filter(event => event.status === 'failed').length} eventos fallidos</summary><p className="!text-sm !text-[var(--crm-text-muted)]">Este registro es para diagnosticar sincronización. Reintentar un evento vuelve a consultar el estado; no inicia otro pago.</p><div className="!overflow-auto"><DataTable aria-label="Eventos de facturación" className="!w-full !text-left !text-sm" filterable={false} sortable={false}><thead><tr>{['Evento','Tipo','Estado','Intentos',''].map((label, index) => <th aria-label={label || 'Acciones'} className="!p-2" key={index}>{label}</th>)}</tr></thead><tbody>{overview.events.map(event => <tr key={event.event_id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2 !text-xs">{event.event_id}</td><td>{event.event_type}</td><td>{billingStatusLabel(event.status)}<br />{event.error_code}</td><td>{event.attempts}</td><td>{event.status === 'failed' ? <Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'retry-event', eventId: event.event_id }); await refresh() })}>Volver a comprobar</Button> : null}</td></tr>)}</tbody></DataTable></div>{!overview.events.length ? <p className="!text-sm">Todavía no hay eventos registrados.</p> : null}</details>
    </> : null}
    {!overview && !error ? <p role="status">Cargando facturación…</p> : null}
  </div>
}
