import { ArrowLeft, ArrowRight, Check, Copy, PackagePlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input } from '../../../../components/ui'
import { DataTable } from '../../../../components/ui/DataTable'
import type { TenantContext } from '../../../../types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { formatInventoryQuantity } from '../../inventory/inventoryModel'
import { loadReplenishmentData, type ReplenishmentRow, type ReplenishmentSupplier } from '../services/replenishmentService'

type Props = { selectedVenueId: string; tenantContext: TenantContext }
type Draft = ReplenishmentRow & { selected: boolean; quantity: string; supplierId: string }
const money = (value: number | null) => value === null ? 'Sin precio' : value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 })

function supplierLabel(supplier: ReplenishmentSupplier) { return `${supplier.name} · ${money(supplier.estimatedUnitCost)}` }
function recommendedLabel(shortage: number, supplier: ReplenishmentSupplier | undefined) {
  if (!supplier?.packageCount) return `Recomendado: ${Math.ceil(shortage)} unidades`
  return `Recomendado: ${Math.ceil(shortage / supplier.packageCount)} formatos de proveedor (${supplier.packageCount} unidades/formato)` 
}

export function PurchasesReplenishmentCrm({ selectedVenueId, tenantContext }: Props) {
  const [rows, setRows] = useState<ReplenishmentRow[]>([])
  const [units, setUnits] = useState<Record<string, { symbol: string; decimals: number }>>({})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [step, setStep] = useState<'selection' | 'summary'>('selection')
  const [copiedSupplierId, setCopiedSupplierId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await loadReplenishmentData(tenantContext, selectedVenueId)
    setRows(data.rows)
    setUnits(Object.fromEntries(data.rows.map((row) => {
      const unit = data.snapshot.units.find((candidate) => candidate.id === row.unitId)
      return [row.itemId, { symbol: unit?.symbol ?? '', decimals: 2 }]
    })))
    setDrafts(Object.fromEntries(data.rows.map((row) => {
      const supplier = row.suppliers[0]
      return [row.itemId, { ...row, selected: true, quantity: String(Math.ceil(row.shortage)), supplierId: supplier?.id ?? '' }]
    })))
  }, [selectedVenueId, tenantContext])

  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudo cargar la reposición.')) }, [refresh])

  const selected = useMemo(() => Object.values(drafts).filter((draft) => draft.selected && Number.isInteger(Number(draft.quantity)) && Number(draft.quantity) > 0), [drafts])
  const grouped = useMemo(() => {
    const result = new Map<string, { supplier: ReplenishmentSupplier | null; items: Array<{ draft: Draft; supplier: ReplenishmentSupplier | null; quantity: number; subtotal: number | null }> }>()
    for (const draft of selected) {
      const supplier = draft.suppliers.find((candidate) => candidate.id === draft.supplierId) ?? null
      const quantity = Number(draft.quantity)
      const key = supplier?.id ?? 'none'
      const group = result.get(key) ?? { supplier, items: [] }
      group.items.push({ draft, supplier, quantity, subtotal: supplier?.estimatedUnitCost == null ? null : quantity * supplier.estimatedUnitCost })
      result.set(key, group)
    }
    return [...result.values()]
  }, [selected])
  const total = grouped.flatMap((group) => group.items).reduce((sum, item) => sum + (item.subtotal ?? 0), 0)

  async function copySupplierOrder(supplierId: string, items: Array<{ draft: Draft; quantity: number }>) {
    await navigator.clipboard.writeText(items.map(({ draft, quantity }) => `${draft.name} -> ${quantity}`).join('\n'))
    setCopiedSupplierId(supplierId)
    window.setTimeout(() => setCopiedSupplierId((current) => current === supplierId ? null : current), 1200)
  }

  function update(id: string, patch: Partial<Draft>) { setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } })) }
  function continueToSummary() {
    if (!selected.length) return setError('Selecciona al menos un artículo con una cantidad a pedir mayor que cero.')
    setError(null); setStep('summary')
  }

  return <section className="grid gap-5">
    <header className="flex flex-col gap-3 rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)] sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">Compras</p><h2 className="mt-1 text-2xl font-black">Reposición</h2><p className="mt-1 text-sm text-[var(--crm-text-muted)]">El faltante muestra existencias reales; la cantidad a pedir se expresa en unidades enteras.</p></div>{step === 'summary' ? <Button onClick={() => setStep('selection')} type="button" variant="secondary"><ArrowLeft className="size-4" /> Volver a selección</Button> : null}</header>
    {error ? <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}
    {step === 'selection' ? <>
      {rows.length ? <><div className="grid gap-3 md:hidden">{rows.map((row) => { const draft = drafts[row.itemId]; const unit = units[row.itemId]; const supplier = row.suppliers.find((candidate) => candidate.id === draft?.supplierId); return <article className="rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]" key={row.itemId}><div className="flex items-start justify-between gap-3"><Checkbox checked={draft?.selected ?? false} onChange={(selectedValue) => update(row.itemId, { selected: selectedValue })}><span className="flex items-center gap-2 font-bold"><PackagePlus className="size-4 text-[var(--crm-blue)]" />{row.name}</span></Checkbox><span className="shrink-0 rounded-lg bg-amber-50 px-2 py-1 font-mono text-sm font-bold text-amber-700">{formatInventoryQuantity(row.shortage, unit.decimals)} {unit.symbol}</span></div><div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[var(--crm-surface-soft)] p-3 text-sm"><span className="text-[var(--crm-text-muted)]">Actual <strong className="ml-1 font-mono text-[var(--crm-text)]">{formatInventoryQuantity(row.stock, unit.decimals)}</strong></span><span className="text-right text-[var(--crm-text-muted)]">Objetivo <strong className="ml-1 font-mono text-[var(--crm-text)]">{formatInventoryQuantity(row.target, unit.decimals)}</strong></span><small className="col-span-2 text-[var(--crm-text-muted)]">{recommendedLabel(row.shortage, supplier)}</small></div><div className="mt-3 grid gap-3"><label className="grid gap-1 text-xs font-bold">Cantidad a pedir (unidades)<Input aria-label={`Cantidad a pedir de ${row.name}`} inputMode="numeric" min="0" onChange={(event) => update(row.itemId, { quantity: event.target.value })} step="1" type="number" value={draft?.quantity ?? ''} /></label><label className="grid gap-1 text-xs font-bold">Proveedor{row.suppliers.length ? <CrmSelect ariaLabel={`Proveedor de ${row.name}`} onChange={(supplierId) => update(row.itemId, { supplierId })} options={row.suppliers.map((candidate) => ({ label: supplierLabel(candidate), value: candidate.id }))} value={draft?.supplierId ?? ''} /> : <span className="rounded-xl bg-[var(--crm-surface-soft)] p-3 text-sm font-normal text-[var(--crm-text-muted)]">Sin proveedor conocido</span>}</label>{supplier?.estimatedUnitCost != null ? <small className="text-[var(--crm-text-muted)]">Precio estimado: <strong className="text-[var(--crm-text)]">{money(supplier.estimatedUnitCost)}</strong></small> : null}</div></article> })}</div><div className="hidden overflow-hidden rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)] md:block"><DataTable aria-label="Artículos pendientes de reposición" className="!w-full !min-w-[980px] !border-collapse" filterPlaceholder="Buscar artículo o proveedor…" toolbarClassName="!border-[var(--crm-border-subtle)] !bg-[var(--crm-surface)] !px-5 !py-4"><thead><tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-xs !font-bold !uppercase !text-[var(--crm-text-muted)]"><th className="!min-w-[240px] !px-5 !py-3" data-column-key="item">Artículo</th><th className="!px-3 !py-3" data-column-key="stock">Actual</th><th className="!px-3 !py-3" data-column-key="target">Objetivo</th><th className="!px-3 !py-3" data-column-key="shortage">Faltante (real)</th><th className="!px-3 !py-3" data-column-key="quantity" data-sortable="false">Cantidad a pedir (unidades)</th><th className="!px-3 !py-3" data-column-key="supplier">Proveedor</th><th className="!px-3 !py-3" data-column-key="price">Precio estimado</th></tr></thead><tbody>{rows.map((row) => {
        const draft = drafts[row.itemId]; const unit = units[row.itemId]
        const supplier = row.suppliers.find((candidate) => candidate.id === draft?.supplierId)
        return <tr className="!border-b !border-[var(--crm-border-subtle)] last:!border-0" key={row.itemId}>
          <td className="!px-5 !py-3" data-filter-value={`${row.name} ${supplier?.name ?? ''}`} data-sort-value={row.name}><Checkbox checked={draft?.selected ?? false} onChange={(selectedValue) => update(row.itemId, { selected: selectedValue })}><span className="flex items-center gap-2"><PackagePlus className="size-4 text-[var(--crm-blue)]" />{row.name}</span></Checkbox></td>
          <td className="!whitespace-nowrap !px-3 !py-3 !font-mono" data-sort-value={row.stock}>{formatInventoryQuantity(row.stock, unit.decimals)} {unit.symbol}</td>
          <td className="!whitespace-nowrap !px-3 !py-3 !font-mono" data-sort-value={row.target}>{formatInventoryQuantity(row.target, unit.decimals)} {unit.symbol}</td>
          <td className="!whitespace-nowrap !px-3 !py-3 !font-mono !font-bold !text-amber-700" data-sort-value={row.shortage}>{formatInventoryQuantity(row.shortage, unit.decimals)} {unit.symbol}<small className="mt-1 block font-sans font-normal text-[var(--crm-text-muted)]">{recommendedLabel(row.shortage, supplier)}</small></td>
          <td className="!w-40 !px-3 !py-3"><Input aria-label={`Cantidad a pedir de ${row.name}`} inputMode="numeric" min="0" onChange={(event) => update(row.itemId, { quantity: event.target.value })} step="1" type="number" value={draft?.quantity ?? ''} /></td>
          <td className="!min-w-64 !px-3 !py-3" data-filter-value={supplier?.name ?? ''} data-sort-value={supplier?.name ?? ''}>{row.suppliers.length ? <CrmSelect ariaLabel={`Proveedor de ${row.name}`} onChange={(supplierId) => update(row.itemId, { supplierId })} options={row.suppliers.map((candidate) => ({ label: supplierLabel(candidate), value: candidate.id }))} value={draft?.supplierId ?? ''} /> : <span className="text-[var(--crm-text-muted)]">Sin proveedor conocido</span>}</td>
          <td className="!whitespace-nowrap !px-3 !py-3" data-sort-value={supplier?.estimatedUnitCost ?? -1}>{supplier?.estimatedUnitCost == null ? <span className="text-[var(--crm-text-muted)]">Sin precio histórico</span> : money(supplier.estimatedUnitCost)}</td>
        </tr>
      })}</tbody></DataTable></div></> : <div className="rounded-3xl bg-[var(--crm-surface)] p-6 shadow-[var(--crm-shadow-card)]"><EmptyList message="No hay artículos pendientes: configura un stock objetivo en Inventario → Artículos." /></div>}
      {rows.length ? <div className="flex justify-end"><Button onClick={continueToSummary} type="button"><ArrowRight className="size-4" /> Continuar al resumen ({selected.length})</Button></div> : null}
    </> : <div className="grid gap-4">{grouped.map((group) => { const supplierKey = group.supplier?.id ?? 'none'; const copied = copiedSupplierId === supplierKey; return <section className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]" key={supplierKey}><div className="flex items-start justify-between gap-4"><h3 className="text-lg font-black">{group.supplier?.name ?? 'Sin proveedor asignado'}</h3><Button aria-label={`Copiar compra de ${group.supplier?.name ?? 'proveedor sin asignar'}`} className={copied ? '!bg-emerald-100 !text-emerald-700 !shadow-md !shadow-emerald-500/15 transition-all duration-300' : 'transition-all duration-300'} onClick={() => void copySupplierOrder(supplierKey, group.items)} size="sm" type="button" variant="secondary">{copied ? <Check className="size-4 animate-in zoom-in-50 duration-300" /> : <Copy className="size-4" />}{copied ? 'Copiado' : 'Copiar'}</Button></div>{!group.supplier ? <p className="mt-1 text-sm text-amber-700">Asigna este artículo manualmente; no hay proveedor o precio histórico conocido.</p> : null}<div className="mt-4 grid gap-2">{group.items.map((item) => <div className="grid gap-2 rounded-xl bg-[var(--crm-surface-soft)] p-3 sm:grid-cols-[1fr_100px_150px_150px] sm:items-center" key={item.draft.itemId}><strong>{item.draft.name}</strong><span className="font-mono">{formatInventoryQuantity(item.quantity, units[item.draft.itemId].decimals)} {units[item.draft.itemId].symbol}</span><span>{money(item.supplier?.estimatedUnitCost ?? null)} <small className="text-[var(--crm-text-muted)]">aprox.</small></span><strong>{item.subtotal === null ? 'Sin subtotal' : money(item.subtotal)}</strong></div>)}</div><div className="mt-4 text-right font-bold">Total proveedor: {money(group.items.reduce((sum, item) => sum + (item.subtotal ?? 0), 0))}</div></section>})}<section className="flex items-center justify-between rounded-3xl bg-[var(--crm-blue-soft)] p-5"><span className="font-bold">Total estimado general <small className="font-normal text-[var(--crm-text-muted)]">(precios históricos aproximados)</small></span><strong className="text-2xl">{money(total)}</strong></section><p className="flex items-center gap-2 text-sm text-[var(--crm-text-muted)]"><Check className="size-4" /> Este flujo termina aquí y no guarda pedidos ni modifica el stock.</p></div>}
  </section>
}
