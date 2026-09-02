import { ArrowDownRight, ArrowUpRight, CalendarDays, Euro, PackageOpen, Store } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { loadPurchaseDocuments, loadPurchaseItemCategories } from '../services/purchaseService'
import type { PurchaseDocument } from '../types'

type Props = { selectedVenueId: string; tenantContext: TenantContext }
const money = (value: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value)
const iso = (date: Date) => date.toISOString().slice(0, 10)

function previousPeriod(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1
  const previousEnd = new Date(startDate); previousEnd.setUTCDate(previousEnd.getUTCDate() - 1)
  const previousStart = new Date(previousEnd); previousStart.setUTCDate(previousStart.getUTCDate() - days + 1)
  return { start: iso(previousStart), end: iso(previousEnd) }
}

function economic(documents: PurchaseDocument[]) { return documents.filter((document) => !document.excludedFromSpend) }
function total(documents: PurchaseDocument[]) { return economic(documents).reduce((sum, document) => sum + document.total, 0) }
function grouped(entries: Array<[string, number]>) {
  const values = new Map<string, number>()
  for (const [name, amount] of entries) values.set(name, (values.get(name) ?? 0) + amount)
  return [...values.entries()].sort((a, b) => b[1] - a[1])
}
function averagePrices(documents: PurchaseDocument[]) {
  const values = new Map<string, { sum: number; count: number }>()
  for (const document of economic(documents)) for (const line of document.lines) {
    if (line.normalizedUnitCost === null) continue
    const name = line.inventoryItemName ?? 'Otros'
    const current = values.get(name) ?? { sum: 0, count: 0 }
    values.set(name, { sum: current.sum + line.normalizedUnitCost, count: current.count + 1 })
  }
  return [...values].map(([name, value]): [string, number] => [name, value.sum / value.count])
}

function Breakdown({ title, values }: { title: string; values: Array<[string, number]> }) {
  const maximum = Math.max(...values.map(([, value]) => value), 1)
  return <section className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
    <h2 className="font-black">{title}</h2>
    <div className="mt-4 grid gap-3">
      {values.slice(0, 6).map(([label, value]) => <div key={label}>
        <div className="flex justify-between gap-3 text-sm"><span className="truncate">{label}</span><strong>{money(value)}</strong></div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--crm-surface-soft)]"><div className="h-full rounded-full bg-[var(--crm-blue)]" style={{ width: `${Math.max(4, value / maximum * 100)}%` }} /></div>
      </div>)}
      {!values.length ? <p className="text-sm text-[var(--crm-text-muted)]">Sin datos en este periodo.</p> : null}
    </div>
  </section>
}

export function PurchasesOverviewCrm({ selectedVenueId, tenantContext }: Props) {
  const now = new Date()
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [endDate, setEndDate] = useState(iso(now))
  const [documents, setDocuments] = useState<PurchaseDocument[]>([])
  const [previous, setPrevious] = useState<PurchaseDocument[]>([])
  const [itemCategories, setItemCategories] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const comparison = previousPeriod(startDate, endDate)
    setError(null)
    void Promise.all([
      loadPurchaseDocuments(tenantContext, selectedVenueId, startDate, endDate),
      loadPurchaseDocuments(tenantContext, selectedVenueId, comparison.start, comparison.end),
    ]).then(async ([current, prior]) => {
      const categoryNames = await loadPurchaseItemCategories(tenantContext, selectedVenueId, [...current, ...prior]
        .flatMap((document) => document.lines.flatMap((line) => line.inventoryItemId ? [line.inventoryItemId] : [])))
      if (active) { setDocuments(current); setPrevious(prior); setItemCategories(categoryNames) }
    })
      .catch((cause) => { if (active) setError(getReadableError(cause)) })
    return () => { active = false }
  }, [endDate, selectedVenueId, startDate, tenantContext])
  const stats = useMemo(() => {
    const spendDocs = economic(documents)
    const spend = total(documents); const prior = total(previous)
    const supplier = grouped(spendDocs.map((document): [string, number] => [document.supplierName ?? 'Sin proveedor', document.total]))
    const product = grouped(spendDocs.flatMap((document) => document.lines.map((line): [string, number] => [line.inventoryItemName ?? 'Otros', line.amount])))
    const category = grouped(spendDocs.flatMap((document) => document.lines.map((line): [string, number] => [line.inventoryItemId ? itemCategories[line.inventoryItemId] ?? 'Otros' : 'Otros', line.amount])))
    const timeline = grouped(spendDocs.map((document): [string, number] => [document.documentDate ?? 'Sin fecha', document.total])).sort((a, b) => a[0].localeCompare(b[0]))
    const currentPrices = averagePrices(spendDocs)
    const previousPrices = new Map(averagePrices(previous))
    const changes = currentPrices.flatMap(([name, price]) => {
      const before = previousPrices.get(name)
      return before && before > 0 ? [[name, (price - before) / before * 100] as [string, number]] : []
    }).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    return { spend, prior, supplier, product, category, timeline, changes }
  }, [documents, itemCategories, previous])
  const variation = stats.prior > 0 ? (stats.spend - stats.prior) / stats.prior * 100 : null
  return <section className="grid gap-5">
    <header className="flex flex-col gap-4 rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)] sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">Compras</p><h2 className="mt-1 text-2xl font-black">Resumen</h2></div>
      <div className="flex gap-2"><label className="text-xs font-bold">Desde<Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="text-xs font-bold">Hasta<Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
    </header>
    {error ? <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}
    <div className="grid gap-4 sm:grid-cols-3">
      <article className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><Euro className="size-5 text-[var(--crm-blue)]"/><p className="mt-3 text-sm text-[var(--crm-text-muted)]">Gasto total</p><strong className="mt-1 block text-3xl font-black">{money(stats.spend)}</strong>{variation !== null ? <span className={`mt-2 inline-flex items-center text-sm font-bold ${variation > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{variation > 0 ? <ArrowUpRight className="size-4"/> : <ArrowDownRight className="size-4"/>}{Math.abs(variation).toFixed(1)}% vs. periodo anterior</span> : null}</article>
      <article className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><CalendarDays className="size-5 text-[var(--crm-blue)]"/><p className="mt-3 text-sm text-[var(--crm-text-muted)]">Documentos contabilizados</p><strong className="mt-1 block text-3xl font-black">{economic(documents).length}</strong></article>
      <article className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><Store className="size-5 text-[var(--crm-blue)]"/><p className="mt-3 text-sm text-[var(--crm-text-muted)]">Proveedores</p><strong className="mt-1 block text-3xl font-black">{stats.supplier.length}</strong></article>
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><Breakdown title="Gasto por proveedor" values={stats.supplier}/><Breakdown title="Gasto por producto" values={stats.product}/><Breakdown title="Gasto por categoría" values={stats.category}/><Breakdown title="Evolución temporal" values={stats.timeline}/></div>
    <section className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="flex items-center gap-2 font-black"><PackageOpen className="size-5"/>Mayores cambios de precio</h2><div className="mt-4 grid gap-2">{stats.changes.slice(0, 8).map(([name, change]) => <div className="flex justify-between rounded-xl bg-[var(--crm-surface-soft)] p-3 text-sm" key={name}><span>{name}</span><strong className={change > 0 ? 'text-amber-600' : 'text-emerald-600'}>{change > 0 ? '+' : ''}{change.toFixed(1)}%</strong></div>)}{!stats.changes.length ? <p className="text-sm text-[var(--crm-text-muted)]">Se mostrará cuando haya precios comparables con el periodo anterior.</p> : null}</div></section>
  </section>
}
