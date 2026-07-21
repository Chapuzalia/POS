import { LoaderCircle, Printer, X } from 'lucide-react'
import type { CashClosingRecord } from '../../types'
import { formatMoney } from '../../lib/format'
import { formatReceiptDate } from '../../features/local-printing/services/receiptFormatters'
import { Button } from '../ui'

const statusLabels: Record<CashClosingRecord['printStatus'], string> = {
  not_requested: 'No solicitada', pending: 'Pendiente', printed: 'Impresa', failed: 'Error', unknown: 'Desconocida',
}

export function CashClosingsHistoryModal({ canReprint, closings, printingClosingId, onClose, onReprint }: {
  canReprint: boolean
  closings: CashClosingRecord[]
  printingClosingId: string | null
  onClose: () => void
  onReprint: (closing: CashClosingRecord) => void
}) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
    <section className="flex max-h-[calc(100svh-32px)] w-full max-w-4xl flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
        <div><h2 className="text-2xl font-black">Historico de cierres</h2><p className="text-sm text-[var(--muted)]">Las copias se generan desde la instantanea guardada al cerrar.</p></div>
        <Button onClick={onClose} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid gap-3">
          {closings.map((closing) => {
            const printing = printingClosingId === closing.id
            return <article className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4" key={closing.id}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="font-black">{closing.printSnapshot.reportTitle} · {closing.printSnapshot.registerName}</p>
                  <p className="text-sm text-[var(--muted)]">{formatReceiptDate(closing.closedAt, closing.printSnapshot.timezone)}</p>
                  <p className="mt-1 font-mono text-xl font-black">{formatMoney(closing.printSnapshot.summary.totalSalesCents)}</p>
                  <p className="text-xs font-bold text-[var(--muted)]">{closing.printSnapshot.summary.salesCount} ventas · Impresion: {statusLabels[closing.printStatus]} · {closing.printCopies} copias</p>
                </div>
                <Button disabled={!canReprint || Boolean(printingClosingId) || closing.printStatus === 'unknown'} onClick={() => onReprint(closing)} type="button" variant="secondary">
                  {printing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                  {printing ? 'Imprimiendo...' : 'Imprimir cierre'}
                </Button>
              </div>
            </article>
          })}
          {!closings.length ? <p className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-8 text-center text-sm font-semibold text-[var(--muted)]">No hay cierres guardados.</p> : null}
        </div>
      </div>
    </section>
  </div>
}
