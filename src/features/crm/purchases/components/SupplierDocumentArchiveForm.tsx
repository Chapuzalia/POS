import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { saveDocumentArchive, uploadDocumentArchive } from '../services/documentArchiveService'
import { loadVenueSuppliers } from '../services/supplierService'
import type { PurchaseDocument, VenueSupplier } from '../types'

type Props = {
  document: PurchaseDocument | null
  disabled: boolean
  onExit: () => void
  selectedVenueId: string
  tenantContext: TenantContext
}

export function SupplierDocumentArchiveForm({ document, disabled, onExit, selectedVenueId, tenantContext }: Props) {
  const [documentType, setDocumentType] = useState<'invoice' | 'delivery_note'>(document?.documentType ?? 'invoice')
  const [documentDate, setDocumentDate] = useState(document?.documentDate ?? new Date().toISOString().slice(0, 10))
  const [documentNumber, setDocumentNumber] = useState(document?.documentNumber ?? '')
  const [supplierId, setSupplierId] = useState(document?.supplierId ?? '')
  const [suppliers, setSuppliers] = useState<VenueSupplier[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void loadVenueSuppliers(tenantContext, selectedVenueId).then((rows) => { if (active) setSuppliers(rows) })
      .catch((cause) => { if (active) setError(getReadableError(cause)) })
    return () => { active = false }
  }, [selectedVenueId, tenantContext])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (disabled || busy) return
    setBusy(true)
    setError(null)
    try {
      const metadata = { supplierId: supplierId || null, documentDate, documentNumber }
      if (document) await saveDocumentArchive(document.id, metadata)
      else {
        if (!file) throw new Error('Selecciona una foto o un PDF.')
        await uploadDocumentArchive(selectedVenueId, documentType, file, metadata)
      }
      onExit()
    } catch (cause) { setError(getReadableError(cause)) }
    finally { setBusy(false) }
  }
  return <form className="grid max-w-2xl gap-5 rounded-3xl bg-[var(--crm-surface)] p-6 shadow-[var(--crm-shadow-card)]" onSubmit={(event) => void save(event)}>
    <div><h2 className="text-2xl font-black">{document ? 'Editar archivo' : 'Archivar factura o albarán'}</h2><p className="mt-2 text-sm text-[var(--crm-text-muted)]">Guarda el original y sus datos para consultarlo o descargarlo. Este archivo no realiza escaneo ni modifica costes o existencias.</p></div>
    <CrmSelect ariaLabel="Tipo de documento" disabled={disabled || busy || Boolean(document)} onChange={(value) => setDocumentType(value === 'invoice' ? 'invoice' : 'delivery_note')} options={[{ value: 'invoice', label: 'Factura' }, { value: 'delivery_note', label: 'Albarán' }]} value={documentType}/>
    <CrmSelect ariaLabel="Proveedor" disabled={disabled || busy} onChange={setSupplierId} options={[{ value: '', label: 'Sin proveedor' }, ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name }))]} searchable value={supplierId}/>
    <label className="grid gap-1 text-sm font-bold">Fecha<Input disabled={disabled || busy} onChange={(event) => setDocumentDate(event.target.value)} required type="date" value={documentDate}/></label>
    <label className="grid gap-1 text-sm font-bold">Número de documento<Input disabled={disabled || busy} maxLength={80} onChange={(event) => setDocumentNumber(event.target.value)} value={documentNumber}/></label>
    {document ? <p className="text-sm">Original: {document.originalFileName}</p> : <label className="grid gap-2 text-sm font-bold">Foto o PDF<Input accept="image/*,application/pdf" disabled={disabled || busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} required type="file"/></label>}
    {document && document.status !== 'confirmed' ? <p className="text-sm text-[var(--crm-text-muted)]">Si se interrumpió la subida del original, vuelve a Archivar documento y selecciona el mismo fichero para reintentarlo.</p> : null}
    {error ? <p role="alert" className="text-sm text-[var(--crm-red)]">{error}</p> : null}
    <div className="flex gap-2"><Button disabled={disabled || busy} type="submit">{busy ? 'Guardando…' : 'Guardar archivo'}</Button><Button disabled={busy} onClick={onExit} type="button" variant="secondary">Volver</Button></div>
  </form>
}
