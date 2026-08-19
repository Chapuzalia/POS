import { Banknote, CreditCard, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { CashSession, SaleRecord } from '../../types'
import { summarizeSales } from '../../features/cash-registers/services/cashSummary'
import { formatMoney } from '../../lib/format'
import { AppModal, Button, Metric } from '../ui'

export function ShiftSummaryModal({
  cashSession,
  error,
  isLoading,
  isOnline,
  onClose,
  onRefresh,
  sales,
}: {
  cashSession: CashSession
  error: string | null
  isLoading: boolean
  isOnline: boolean
  onClose: () => void
  onRefresh: () => void
  sales: SaleRecord[]
}) {
  const summary = summarizeSales(0, sales)

  return <AppModal dismissDisabled={isLoading} label="Resumen de turno" maxWidth={620} onClose={onClose}>
    <section className="w-full rounded-[var(--radius)] bg-[var(--surface)] p-5 text-[var(--foreground)]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black">Resumen de turno</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{cashSession.cashRegisterName} · desde {new Date(cashSession.openedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</p>
        </div>
        <Button aria-label="Cerrar resumen de turno" disabled={isLoading} onClick={onClose} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="relative">
          <Banknote aria-hidden="true" className="pointer-events-none absolute right-4 top-4 z-10 h-5 w-5 text-emerald-600" />
          <Metric label="Efectivo facturado" value={formatMoney(summary.cashCents)} />
        </div>
        <div className="relative">
          <CreditCard aria-hidden="true" className="pointer-events-none absolute right-4 top-4 z-10 h-5 w-5 text-blue-600" />
          <Metric label="Tarjeta facturada" value={formatMoney(summary.cardCents)} />
        </div>
      </div>

      <p className="mt-4 text-sm text-[var(--muted)]">No incluye el fondo inicial ni las entradas o salidas manuales de caja.</p>
      {!isOnline ? <p className="mt-3 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">Sin conexión: se muestra el resumen guardado en este POS.</p> : null}
      {error ? <p className="mt-3 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm font-semibold text-red-800 dark:text-red-200">{error}</p> : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={isLoading || !isOnline} onClick={onRefresh} type="button" variant="secondary">
          {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {isLoading ? 'Actualizando…' : 'Actualizar'}
        </Button>
        <Button disabled={isLoading} onClick={onClose} type="button" variant="primary">Cerrar</Button>
      </div>
    </section>
  </AppModal>
}
