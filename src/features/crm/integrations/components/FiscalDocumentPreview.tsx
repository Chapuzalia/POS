import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { CrmModal } from '../../shared/components/CrmModal'
import { buildRefundDocument, buildTicketDocument } from '../services/fiscalInvoiceDocument'
import type { CrmSalesReportRefundDocument, CrmSalesReportTicket, TenantContext } from '../../../../types'

type FiscalDocumentPreviewProps = {
  ticket: CrmSalesReportTicket
  context: TenantContext
  refund: CrmSalesReportRefundDocument | null
  onClose: () => void
}

export function FiscalDocumentPreview({ ticket, context, refund, onClose }: FiscalDocumentPreviewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const historyMarker = useRef<string | null>(null)
  const historyCleanup = useRef<number | undefined>(undefined)
  const [html, setHtml] = useState('')
  const [error, setError] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    void (refund ? buildRefundDocument(ticket, refund, context) : buildTicketDocument(ticket, context))
      .then((document) => { if (active) setHtml(document) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [ticket, context, refund])

  useEffect(() => {
    // A history entry lets the phone's back gesture close the preview without leaving the CRM.
    window.clearTimeout(historyCleanup.current)
    const marker = historyMarker.current ?? crypto.randomUUID()
    historyMarker.current = marker
    if (window.history.state?.fiscalPreview !== marker) window.history.pushState({ ...window.history.state, fiscalPreview: marker }, '')
    const back = () => onClose()
    window.addEventListener('popstate', back)
    return () => {
      window.removeEventListener('popstate', back)
      // Defer cleanup so React StrictMode's effect replay does not navigate back.
      historyCleanup.current = window.setTimeout(() => {
        if (window.history.state?.fiscalPreview === marker) window.history.back()
      }, 0)
    }
  }, [onClose])

  return <CrmModal
    label="Vista previa del documento fiscal"
    onClose={onClose}
    closeOnOutsidePress={false}
    size="large"
    scroll="content"
    dialogClassName="!flex !h-[calc(100dvh-48px)] !flex-col"
  >
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-surface)] p-3">
      <Button className="!min-h-11" onClick={onClose} type="button" variant="tertiary"><ArrowLeft className="size-4" />Volver al ticket</Button>
      <Button className="!min-h-11" disabled={!ready} onClick={() => frame.current?.contentWindow?.print()} type="button"><Download className="size-4" />Guardar PDF</Button>
    </div>
    {error ? <p className="p-6 text-[var(--crm-red)]" role="alert">No se ha podido generar el documento. Vuelve al ticket e inténtalo de nuevo.</p>
      : html ? <iframe className="min-h-0 w-full flex-1 border-0 bg-white" onLoad={() => setReady(true)} ref={frame} srcDoc={html} title="Documento fiscal" />
        : <p className="p-6" role="status">Preparando documento…</p>}
  </CrmModal>
}
