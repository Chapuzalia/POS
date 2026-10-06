import { Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { CrmModal } from '../../shared/components/CrmModal'
import { useCrmModalBusy } from '../../shared/components/CrmModalBusyContext'
import { deletePurchaseDocument, type PurchaseDocumentDeletion } from '../services/purchaseService'
import type { PurchaseDocument } from '../types'

type Props = {
  document: PurchaseDocument
  disabled: boolean
  tenantContext: TenantContext
  selectedVenueId: string
  onClose: () => void
  onDeleted: (result: PurchaseDocumentDeletion) => void
}

export function DeletePurchaseDocumentModal({ document, disabled, tenantContext, selectedVenueId, onClose, onDeleted }: Props) {
  const [reverseStock, setReverseStock] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleting = useRef(false)
  const modalBusy = useCrmModalBusy(busy)
  const hasStock = document.stockAppliedAt !== null
  const needsChoice = hasStock && reverseStock === null
  const close = () => { if (!deleting.current) onClose() }
  async function remove() {
    if (disabled || modalBusy || deleting.current || needsChoice) return
    deleting.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await deletePurchaseDocument(tenantContext, selectedVenueId, document.id, hasStock ? reverseStock : null)
      onDeleted(result)
    } catch (cause) {
      setError(getReadableError(cause, { operation: 'features.crm.purchases.components.DeletePurchaseDocumentModal' }))
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }
  return <CrmModal dismissDisabled={busy || modalBusy} label="Eliminar documento" onClose={close}>
    <div className="grid gap-5 p-5">
      <header className="flex items-center justify-between gap-3"><h3 className="text-lg font-black">Eliminar documento</h3><Button aria-label="Cerrar" disabled={busy || modalBusy} onClick={close} type="button" variant="tertiary"><X className="size-4"/></Button></header>
      <p className="text-sm">Se eliminará {document.documentType === 'invoice' ? 'la factura' : 'el albarán'} <strong>{document.documentNumber ?? 'sin número'}</strong>{document.supplierName ? ` de ${document.supplierName}` : ''} y su fichero original.</p>
      {document.linkedDocumentCount > 0 ? <p className="text-sm text-[var(--crm-text-muted)]">También se quitarán sus vínculos con otros documentos.</p> : null}
      {hasStock ? <fieldset className="grid gap-3" disabled={busy}>
        <legend className="mb-3 text-sm font-bold">¿Quieres anular también el stock registrado por este documento?</legend>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-[var(--crm-border-subtle)] p-3 text-sm"><input checked={reverseStock === false} className="size-4 accent-[var(--crm-blue)]" name="delete-document-stock" onChange={() => setReverseStock(false)} type="radio"/>No, mantener el stock</label>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-[var(--crm-border-subtle)] p-3 text-sm"><input checked={reverseStock === true} className="size-4 accent-[var(--crm-red)]" name="delete-document-stock" onChange={() => setReverseStock(true)} type="radio"/>Sí, anular el stock registrado</label>
      </fieldset> : null}
      {reverseStock === true ? <p className="text-sm text-[var(--crm-text-muted)]">Se descontarán las cantidades que registró este documento, incluidas sus correcciones posteriores.</p> : null}
      {error ? <p className="rounded-xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]" role="alert">{error}</p> : null}
      <footer className="flex justify-end gap-2"><Button disabled={busy || modalBusy} onClick={close} type="button" variant="secondary">Cancelar</Button><Button disabled={disabled || modalBusy || busy || needsChoice} onClick={() => void remove()} type="button" variant="danger"><Trash2 className="size-4"/>{busy ? 'Eliminando…' : 'Eliminar documento'}</Button></footer>
    </div>
  </CrmModal>
}
