import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { BillingCatalogEditor } from './BillingCatalogEditor'
import { TenantBillingPanel, billingCard, billingField } from './TenantBillingPanel'
import { billingDate, billingMoney, billingRequest } from './service'
import type { BillingCatalog, BillingOverview } from './types'

export default function BillingAdmin({ disabled }: { disabled: boolean }) {
  const [section, setSection] = useState<'dashboard' | 'clients' | 'catalog' | 'monitor'>('dashboard')
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const [next, commercial] = await Promise.all([billingRequest<BillingOverview>({ action: 'overview' }), billingRequest<BillingCatalog>({ action: 'catalog' })])
    setOverview(next); setCatalog(commercial)
  }, [])
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo cargar la facturación.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { if (!disabled) void run(refresh) }, [disabled, refresh, run])
  const locked = disabled || busy
  const accounts = overview?.accounts ?? []
  const filtered = accounts.filter(account => `${account.name} ${account.tax_id ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (!status || account.status === status))
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const distribution = new Map<string, number>()
  for (const account of accounts) if (account.contract && ['active','past_due','trialing'].includes(account.status)) distribution.set(account.contract.planName, (distribution.get(account.contract.planName) ?? 0) + 1)
  return <div className="!grid !gap-5 [&_button]:!min-h-11">
    <div className="!flex !flex-wrap !items-center !justify-between !gap-3"><nav aria-label="Áreas de facturación" className="!flex !flex-wrap !gap-2">{[{ key: 'dashboard', label: 'Resumen' }, { key: 'clients', label: 'Clientes' }, { key: 'catalog', label: 'Catálogo' }, { key: 'monitor', label: 'Supervisión' }].map(item => <Button key={item.key} aria-pressed={section === item.key} disabled={disabled} onClick={() => { setSection(item.key as typeof section); setTenantId(null) }}>{item.label}</Button>)}</nav><Button disabled={locked} onClick={() => void run(refresh)}>Actualizar</Button></div>
    {error ? <p role="alert" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-[var(--crm-red)]">{error}</p> : null}
    {overview?.truncated ? <p role="status" className="!rounded-[var(--crm-radius-md)] !bg-[var(--crm-yellow-soft)] !p-4">La consulta de datos auxiliares alcanzó el límite. El MRR y ARR incluyen todas las cuentas; los cobros y locales requieren una consulta acotada adicional.</p> : null}
    {section === 'dashboard' && overview ? <>
      <div className="!grid !gap-4 sm:!grid-cols-2 lg:!grid-cols-4">{[
        ['MRR contratado, sin impuestos', billingMoney(overview.metrics.mrrCents)], ['ARR contratado, sin impuestos', billingMoney(overview.metrics.arrCents)],
        ['Cobrado este mes (con impuestos)', billingMoney(overview.metrics.paidCents)], ['Cobrado este mes (sin impuestos)', billingMoney(overview.metrics.paidExcludingTaxCents)],
        ['Suscripciones activas', accounts.filter(row => row.status === 'active').length], ['En prueba', accounts.filter(row => row.status === 'trialing').length],
        ['Pendientes de pago', accounts.filter(row => ['past_due','unpaid','incomplete'].includes(row.status)).length], ['Canceladas', accounts.filter(row => row.status === 'canceled').length],
        ['Altas de suscripción este mes', accounts.filter(row => row.subscription_started_at && Date.parse(row.subscription_started_at) >= startOfMonth).length],
        ['Bajas de suscripción este mes', accounts.filter(row => row.canceled_at && Date.parse(row.canceled_at) >= startOfMonth).length],
      ].map(([label, value]) => <article className={billingCard} key={label}><p className="!text-xs !text-[var(--crm-text-muted)]">{label}</p><strong className="!mt-2 !block !text-2xl">{value}</strong></article>)}</div>
      <section className={billingCard}><h2 className="!mb-3 !font-semibold">Distribución de suscripciones por plan</h2>{[...distribution].map(([name, count]) => <p className="!my-2 !text-sm" key={name}>{name}: <strong>{count}</strong></p>)}<p className="!mt-4 !text-xs !text-[var(--crm-text-muted)]">MRR y ARR incluyen contratos activos y en mora; excluyen pruebas, impuestos, prorrateos y cuentas manuales. Cada contrato consolidado se cuenta una vez. Los cobros se basan en facturas pagadas y no representan liquidaciones bancarias.</p></section>
    </> : null}
    {section === 'clients' ? tenantId ? <><div><Button onClick={() => setTenantId(null)}>Volver a clientes</Button></div><TenantBillingPanel key={tenantId} tenantId={tenantId} admin disabled={disabled} onChanged={() => void run(refresh)} /></> : <section className={billingCard}><div className="!mb-4 !grid !gap-3 sm:!grid-cols-2"><Input className={billingField} aria-label="Buscar empresa o NIF" placeholder="Buscar empresa o NIF…" value={search} onChange={event => setSearch(event.target.value)} /><select className={billingField} aria-label="Filtrar estado de suscripción" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos los estados</option>{[...new Set(accounts.map(row => row.status))].map(value => <option key={value} value={value}>{value}</option>)}</select></div><div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr>{['Empresa / NIF','Plan / addons','Locales','Recurrente','Estado / pago','Vencimiento',''].map((label, index) => <th className="!p-2" key={index}>{label}</th>)}</tr></thead><tbody>{filtered.map(account => <tr className="!border-t !border-[var(--crm-border)]" key={account.tenant_id}><td className="!p-2">{account.name}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{account.tax_id ?? '—'}</span></td><td>{account.contract?.planName ?? 'Manual'}<br /><span className="!text-xs !text-[var(--crm-text-muted)]">{account.contract?.addons.filter(addon => addon.quantity > 0).map(addon => catalog?.products.find(product => product.key === addon.key)?.name ?? addon.key).join(', ')}</span></td><td>{account.venueCount}</td><td>{account.contract ? `${billingMoney(account.contract.recurringCents)} / ${account.contract.interval === 'month' ? 'mes' : 'año'}` : '—'}</td><td>{account.status}<br />{account.last_payment_status ?? '—'}</td><td>{billingDate(account.period_end)}</td><td><Button disabled={disabled} onClick={() => setTenantId(account.tenant_id)}>Ver detalle</Button></td></tr>)}</tbody></table></div></section> : null}
    {section === 'catalog' && catalog ? <BillingCatalogEditor catalog={catalog} onSaved={refresh} disabled={disabled} /> : null}
    {section === 'monitor' && overview ? <>
      <section className={billingCard}><div className="!mb-4 !flex !flex-wrap !items-center !justify-between !gap-3"><h2 className="!font-semibold">Sincronización y conciliación</h2><Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'reconcile-batch' }); await refresh() })}>Conciliar 20 cuentas pendientes</Button></div><div className="!grid !gap-3">{accounts.filter(account => account.stripe_customer_id).map(account => <div key={account.tenant_id} className="!flex !flex-wrap !items-center !justify-between !gap-2 !text-sm"><span>{account.name} · {billingDate(account.last_reconciled_at)} · {account.sync_error ?? 'Sin incidencias registradas'}</span><Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'reconcile', tenantId: account.tenant_id }); await refresh() })}>Conciliar</Button></div>)}</div></section>
      <section className={billingCard}><h2 className="!mb-4 !font-semibold">Últimos eventos de Stripe</h2><div className="!overflow-auto"><table className="!w-full !text-left !text-sm"><thead><tr>{['Evento','Tipo','Estado','Intentos',''].map((label, index) => <th className="!p-2" key={index}>{label}</th>)}</tr></thead><tbody>{overview.events.map(event => <tr key={event.event_id} className="!border-t !border-[var(--crm-border)]"><td className="!p-2 !text-xs">{event.event_id}</td><td>{event.event_type}</td><td>{event.status}<br />{event.error_code}</td><td>{event.attempts}</td><td>{event.status === 'failed' ? <Button disabled={locked} onClick={() => void run(async () => { await billingRequest({ action: 'retry-event', eventId: event.event_id }); await refresh() })}>Reintentar</Button> : null}</td></tr>)}</tbody></table></div></section>
    </> : null}
    {!overview && !error ? <p role="status">Cargando facturación sandbox…</p> : null}
  </div>
}
