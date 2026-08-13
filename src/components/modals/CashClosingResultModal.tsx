import { CheckCircle2, LoaderCircle, Printer, X } from 'lucide-react'
import type { CashClosingRecord } from '../../types'
import { formatMoney } from '../../lib/format'
import { getCashClosingAmounts } from '../../features/cash-registers/services/cashClosingAmounts'
import { AppModal, Button, Metric } from '../ui'

export function CashClosingResultModal({ closing, isPrinting, onClose, onPrint }: {
  closing: CashClosingRecord
  isPrinting: boolean
  onClose: () => void
  onPrint: () => void
}) {
  const printed = closing.printStatus === 'printed'
  const unknown = closing.printStatus === 'unknown'
  const amounts = getCashClosingAmounts(closing.printSnapshot)
  return <AppModal containerClassName="!p-4" maxWidth={672} dismissDisabled={isPrinting} label="Cierre completado" onClose={onClose}>
    <section className="w-full max-w-2xl rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-1 h-7 w-7 text-emerald-600" />
          <div><h2 className="text-2xl font-black">Cierre completado</h2><p className="text-sm text-[var(--muted)]">El cierre se ha guardado. La impresión es independiente.</p></div>
        </div>
        <Button disabled={isPrinting} onClick={onClose} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Total ventas" value={formatMoney(closing.printSnapshot.summary.totalSalesCents)} />
        <Metric label="Ventas" value={String(closing.printSnapshot.summary.salesCount)} />
        <Metric label="Diferencia efectivo" value={formatMoney(closing.printSnapshot.differences.cashDifferenceCents)} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Metric label="Entradas de efectivo" value={formatMoney(closing.printSnapshot.cashMovements.cashEntriesCents)} />
        <Metric label="Salidas de efectivo" value={formatMoney(closing.printSnapshot.cashMovements.cashExitsCents)} />
        <Metric label="Efectivo por tarjeta" value={formatMoney(closing.printSnapshot.cashMovements.cardCashbackCents)} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Metric label="Efectivo facturado" value={formatMoney(amounts.billedCashCents)} />
        <Metric label="Datáfono esperado" value={formatMoney(amounts.cardTerminalExpectedCents)} />
        <Metric
          label={amounts.cashToWithdrawCents >= 0 ? 'Retirar de caja' : 'Añadir a caja'}
          value={formatMoney(Math.abs(amounts.cashToWithdrawCents))}
        />
      </div>
      {unknown ? <p className="mt-4 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-bold text-amber-700">No se puede confirmar si el cierre se imprimió. Comprueba la impresora antes de volver a imprimir.</p> : null}
      {closing.printStatus === 'failed' ? <p className="mt-4 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm font-bold text-red-700">El cierre se ha guardado, pero no se ha podido imprimir. Puedes reintentar con el mismo identificador.</p> : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} type="button" variant="secondary">Cerrar</Button>
        <Button disabled={isPrinting || printed || unknown} onClick={onPrint} type="button" variant="primary">
          {isPrinting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
          {isPrinting ? 'Imprimiendo...' : printed ? 'Cierre impreso' : 'Imprimir cierre'}
        </Button>
      </div>
    </section>
  </AppModal>
}
