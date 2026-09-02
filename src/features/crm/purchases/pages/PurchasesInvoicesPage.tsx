import { AlertTriangle, CheckCircle2, Clock3, Download, FileArchive, FilePlus2, Link2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { SupplierReceiptsCrm } from '../../supplier-documents/pages/SupplierReceiptsPage'
import { downloadPurchaseOriginal, exportPurchaseDocuments, loadPurchaseDocuments } from '../services/purchaseService'
import type { PurchaseDocument } from '../types'

type Props = { disabled: boolean; selectedVenueId: string; tenantContext: TenantContext }
const iso = (date: Date) => date.toISOString().slice(0, 10)
const money = (value: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value)

const statusPresentation: Record<PurchaseDocument['status'], {
  cardClassName: string
  icon: typeof CheckCircle2
  label: string
  badgeClassName: string
}> = {
  confirmed: {
    cardClassName: 'border-[var(--crm-border-subtle)] bg-[var(--crm-surface)]',
    icon: CheckCircle2,
    label: 'Confirmado',
    badgeClassName: 'bg-[var(--crm-surface-soft)] text-[var(--crm-text-muted)]',
  },
  processing: {
    cardClassName: 'border-blue-400/70 bg-blue-50/60 dark:bg-blue-950/20',
    icon: RefreshCw,
    label: 'Procesando',
    badgeClassName: 'bg-blue-600 text-white shadow-sm',
  },
  review: {
    cardClassName: 'border-amber-400/80 bg-amber-50/70 dark:bg-amber-950/20',
    icon: Clock3,
    label: 'Pendiente de revisión',
    badgeClassName: 'bg-amber-500 text-amber-950 shadow-sm',
  },
  error: {
    cardClassName: 'border-red-400/80 bg-red-50/70 dark:bg-red-950/20',
    icon: AlertTriangle,
    label: 'Error',
    badgeClassName: 'bg-red-600 text-white shadow-sm',
  },
}

function PurchaseStatusBadge({ status }: { status: PurchaseDocument['status'] }) {
  const presentation = statusPresentation[status]
  const Icon = presentation.icon
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-black ${presentation.badgeClassName}`}><Icon className={`size-3.5 ${status === 'processing' ? 'animate-spin' : ''}`}/>{presentation.label}</span>
}

export function PurchasesInvoicesCrm({ disabled, selectedVenueId, tenantContext }: Props) {
  const now = new Date()
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
  const [endDate, setEndDate] = useState(iso(now))
  const [documents, setDocuments] = useState<PurchaseDocument[]>([])
  const [type, setType] = useState('all'); const [supplier, setSupplier] = useState('all'); const [status, setStatus] = useState('all'); const [query, setQuery] = useState('')
  const [editorDocumentId, setEditorDocumentId] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => { setDocuments(await loadPurchaseDocuments(tenantContext, selectedVenueId, startDate, endDate, { includeUnconfirmed: true })) }, [endDate, selectedVenueId, startDate, tenantContext])
  useEffect(() => { let active = true; setError(null); void loadPurchaseDocuments(tenantContext, selectedVenueId, startDate, endDate, { includeUnconfirmed: true }).then((next) => { if (active) setDocuments(next) }).catch((cause) => { if (active) setError(getReadableError(cause)) }); return () => { active = false } }, [endDate, selectedVenueId, startDate, tenantContext])
  const hasProcessingDocuments = documents.some((document) => document.status === 'processing')
  useEffect(() => {
    if (!hasProcessingDocuments) return
    const timer = window.setInterval(() => { void refresh().catch((cause) => setError(getReadableError(cause))) }, 5_000)
    return () => window.clearInterval(timer)
  }, [hasProcessingDocuments, refresh])
  const suppliers = useMemo(() => [...new Set(documents.map((document) => document.supplierName).filter((name): name is string => Boolean(name)))].sort(), [documents])
  const filtered = useMemo(() => documents.filter((document) => (type === 'all' || document.documentType === type) && (supplier === 'all' || document.supplierName === supplier) && (status === 'all' || document.status === status) && (!query.trim() || `${document.documentNumber ?? ''} ${document.supplierName ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [documents, query, status, supplier, type])
  const exportable = filtered.filter((document) => document.status === 'confirmed' && document.documentDate && document.documentDate >= startDate && document.documentDate <= endDate)
  async function run(action: () => Promise<void>) { setBusy(true); setError(null); try { await action() } catch (cause) { setError(getReadableError(cause)) } finally { setBusy(false) } }
  if (editorDocumentId !== undefined) return <SupplierReceiptsCrm disabled={disabled} initialDocumentId={editorDocumentId} onExit={() => { setEditorDocumentId(undefined); void run(refresh) }} selectedVenueId={selectedVenueId} tenantContext={tenantContext}/>
  return <section className="grid gap-5">
    <header className="flex flex-col gap-4 rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)] lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">Compras</p><h2 className="mt-1 text-2xl font-black">Facturas y albaranes</h2></div><div className="flex flex-wrap gap-2"><Button disabled={disabled || busy} onClick={() => setEditorDocumentId(null)} type="button" variant="primary"><FilePlus2 className="size-4"/>Nuevo documento</Button><Button disabled={busy || !exportable.length} onClick={() => void run(async () => { await exportPurchaseDocuments(exportable, startDate, endDate) })} type="button" variant="secondary"><FileArchive className="size-4"/>Exportar</Button></div></header>
    <div className="grid gap-3 rounded-3xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)] sm:grid-cols-2 lg:grid-cols-6"><label className="text-xs font-bold">Desde<Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}/></label><label className="text-xs font-bold">Hasta<Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)}/></label><CrmSelect ariaLabel="Tipo" onChange={setType} options={[{ value: 'all', label: 'Todos los tipos' }, { value: 'invoice', label: 'Facturas' }, { value: 'delivery_note', label: 'Albaranes' }]} value={type}/><CrmSelect ariaLabel="Proveedor" onChange={setSupplier} options={[{ value: 'all', label: 'Todos los proveedores' }, ...suppliers.map((name) => ({ value: name, label: name }))]} searchable value={supplier}/><CrmSelect ariaLabel="Estado" onChange={setStatus} options={[{ value: 'all', label: 'Todos los estados' }, { value: 'processing', label: 'Procesando' }, { value: 'review', label: 'Pendiente de revisión' }, { value: 'confirmed', label: 'Confirmado' }, { value: 'error', label: 'Error' }]} value={status}/><label className="relative"><span className="sr-only">Buscar</span><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-[var(--crm-text-muted)]"/><Input className="!pl-9" placeholder="Número o proveedor" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
    {error ? <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}
    <div className="grid gap-3">{filtered.map((document) => <article className={`grid gap-4 rounded-3xl border-2 p-5 shadow-[var(--crm-shadow-card)] md:grid-cols-[1fr_auto] md:items-center ${statusPresentation[document.status].cardClassName}`} key={document.id}><button className="min-w-0 text-left" onClick={() => setEditorDocumentId(document.id)} type="button"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[var(--crm-blue-soft)] px-2.5 py-1 text-xs font-black text-[var(--crm-blue)]">{document.documentType === 'invoice' ? 'Factura' : 'Albarán'}</span><span className="text-sm text-[var(--crm-text-muted)]">{document.documentDate ?? 'Fecha pendiente'}</span><PurchaseStatusBadge status={document.status}/>{document.linkedDocumentCount ? <span className="inline-flex items-center gap-1 text-xs text-[var(--crm-text-muted)]"><Link2 className="size-3"/>Vinculado</span> : null}</div><h3 className="mt-2 truncate text-lg font-black">{document.supplierName ?? 'Sin proveedor'}</h3><p className="mt-1 text-sm text-[var(--crm-text-muted)]">{document.documentNumber ?? 'Sin número'} · {document.affectsStock ? 'Stock actualizado' : 'Sin cambio de stock'}{document.excludedFromSpend ? ' · Gasto contabilizado por factura vinculada' : ''}</p></button><div className="flex items-center justify-between gap-3 md:justify-end"><strong className="text-xl">{money(document.total)}</strong><Button aria-label="Descargar original" disabled={!document.storagePath || busy} onClick={() => void run(() => downloadPurchaseOriginal(document))} type="button" variant="tertiary"><Download className="size-4"/></Button></div></article>)}{!filtered.length ? <div className="rounded-3xl bg-[var(--crm-surface)] p-10 text-center text-sm text-[var(--crm-text-muted)] shadow-[var(--crm-shadow-card)]">No hay documentos para los filtros seleccionados.</div> : null}</div>
  </section>
}
