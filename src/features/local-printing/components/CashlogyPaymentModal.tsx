import { AlertTriangle, Ban, CheckCircle2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { shouldShowCashlogyOperationDetails } from '../cashlogy/cashlogyPresentation'
import { isUncertainCashlogyError } from '../cashlogy/cashlogyError'
import { cashlogyActiveStatuses, cashlogyCancellableStatuses } from '../cashlogy/cashlogyPolling'
import { useCashlogyStore } from '../cashlogy/useCashlogyStore'
import type { CashlogyTransaction, CashlogyTransactionStatus } from '../types'
import { CashlogyLevelCards } from './CashlogyLevelCards'

const statusLabels: Record<CashlogyTransactionStatus, string> = {
  queued: 'Preparando Cashlogy',
  connecting: 'Conectando con Cashlogy',
  initializing: 'Preparando Cashlogy',
  starting_acceptance: 'Iniciando admisión',
  waiting_for_cash: 'Introduce el efectivo',
  finalizing_acceptance: 'Finalizando admisión',
  dispensing_change: 'Devolviendo cambio',
  processing: 'Procesando resultado',
  completed: 'Cobro completado',
  cancelled: 'Cobro cancelado',
  failed: 'Cobro fallido',
  unknown: 'Resultado desconocido',
  needs_attention: 'Revisión manual necesaria',
}

export function CashlogyPaymentModal({ finalizeDisabled, onFinalizeRecovered }: { finalizeDisabled?: boolean; onFinalizeRecovered: (transaction: CashlogyTransaction) => Promise<void> | void }) {
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [reviewedId, setReviewedId] = useState<string | null>(null)
  const state = useCashlogyStore(useShallow((value) => ({
    modalOpen: value.modalOpen,
    intent: value.intent,
    transaction: value.transaction,
    levels: value.levels,
    error: value.error,
    isStarting: value.isStarting,
    isPolling: value.isPolling,
    isCancelling: value.isCancelling,
    cancel: value.cancel,
    recover: value.recover,
    hide: value.hide,
    discardForRetry: value.discardForRetry,
    closeReviewed: value.closeReviewed,
  })))
  const acceptedCents = (state.transaction?.automaticAcceptedCents ?? 0) + (state.transaction?.manualAcceptedCents ?? 0)

  if (!state.modalOpen || !state.intent) return null

  const status = state.transaction?.status
  const reviewed = Boolean(state.transaction && reviewedId === state.transaction.id)
  const active = status ? cashlogyActiveStatuses.has(status) : state.isStarting || state.isPolling
  const previousCompleted = status === 'completed' && state.intent.recoveredFromConflict
  const critical = status === 'unknown' || status === 'needs_attention' || previousCompleted
  const startFailed = !state.transaction && Boolean(state.error) && !state.isStarting && !state.isPolling
  const preservePending = state.intent.recoveredFromConflict || (state.intent.chargeRequestedAt && isUncertainCashlogyError(state.error))
  const canCancel = Boolean(status && cashlogyCancellableStatuses.has(status) && !state.isCancelling)
  const showOperationDetails = shouldShowCashlogyOperationDetails(status)

  const finalizeRecovered = async () => {
    if (!state.transaction || state.intent?.recoveredFromConflict || isFinalizing) return
    setIsFinalizing(true)
    try {
      await onFinalizeRecovered(state.transaction)
    } finally {
      setIsFinalizing(false)
    }
  }

  return <AppModal dismissDisabled label="Cobro Cashlogy" maxWidth={520} onClose={state.hide}>
    <section className="w-full p-6">
      <div className={`flex items-start gap-3 rounded-[var(--radius)] border p-4 ${critical ? 'border-red-500 bg-red-500/10' : 'border-[var(--separator)] bg-[var(--background)]'}`}>
        {critical ? <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
          : status === 'completed' ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
            : status === 'cancelled' || status === 'failed' || startFailed ? <Ban className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
              : <LoaderCircle className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-[var(--accent)]" />}
        <div>
          <h2 className="text-xl font-black">{state.isCancelling
            ? 'Cancelando cobro…'
            : status
              ? statusLabels[status]
              : startFailed
                ? 'No se pudo iniciar el cobro'
                : state.isStarting
                  ? 'Conectando con Cashlogy…'
                  : 'Recuperando operación'}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {critical
              ? 'No repitas el cobro. Comprueba físicamente la máquina y revisa la operación con el responsable de caja.'
              : startFailed
                ? 'Revisa el mensaje de error antes de volver al pago.'
              : status === 'waiting_for_cash'
                ? 'Introduce billetes y monedas en Cashlogy. Puedes cancelar el cobro o volver al TPV.'
                : state.isStarting
                  ? 'Espera mientras se comprueba la máquina. El cobro ya está bloqueado para evitar duplicados.'
                  : 'Puedes volver al TPV; el cobro seguirá controlado y podrás consultar su estado de nuevo.'}
          </p>
        </div>
      </div>

      {showOperationDetails ? <>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Metric label="Importe solicitado" value={formatMoney(state.intent.amountCents)} />
          <Metric label="Efectivo aceptado" value={formatMoney(acceptedCents)} />
          {state.transaction?.returnedCents !== null && state.transaction?.returnedCents !== undefined
            ? <Metric label="Cambio devuelto" value={formatMoney(state.transaction.returnedCents)} />
            : null}
          {state.transaction?.netPaidCents !== null && state.transaction?.netPaidCents !== undefined
            ? <Metric label="Neto pagado" value={formatMoney(state.transaction.netPaidCents)} />
            : null}
        </div>

        <CashlogyLevelCards levels={state.levels} variant="payment" />
      </> : null}

      {state.error ? <div className="mt-4 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm">
        <p className="font-bold text-red-700 dark:text-red-300">{state.error.message}</p>
      </div> : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {critical ? <label className="w-full text-sm">
          <input type="checkbox" checked={reviewed} onChange={(event) => setReviewedId(event.target.checked ? state.transaction?.id ?? null : null)} className="mr-2" />
          He revisado el efectivo con el responsable de caja y la máquina ya no tiene una operación pendiente. Cerrar no registrará esta venta como pagada.
        </label> : null}
        {(active && !state.isPolling && !state.isStarting) || startFailed ? <Button onClick={() => void state.recover().catch(() => undefined)}>Recuperar cobro</Button> : null}
        {active ? <Button onClick={state.hide} variant="tertiary">Volver al TPV</Button> : null}
        {canCancel ? <Button disabled={state.isCancelling} onClick={() => void state.cancel().catch(() => undefined)} variant="danger">
          {state.isCancelling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Cancelar cobro
        </Button> : null}
        {status === 'completed' && state.transaction && !previousCompleted ? <Button disabled={finalizeDisabled || isFinalizing} onClick={() => void finalizeRecovered()} variant="primary">
          {isFinalizing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {isFinalizing ? 'Registrando venta…' : 'Aplicar cobro confirmado'}
        </Button> : null}
        {status === 'cancelled' ? <Button onClick={state.discardForRetry}>Volver al pago</Button> : null}
        {status === 'failed' ? <Button onClick={state.discardForRetry} variant="primary">Iniciar un nuevo intento</Button> : null}
        {startFailed ? <Button onClick={preservePending ? state.hide : state.discardForRetry} variant="primary">{preservePending ? 'Volver al TPV' : 'Volver al pago'}</Button> : null}
        {critical ? <>
          <Button disabled={state.isPolling} onClick={() => void state.recover().catch(() => undefined)} variant="primary">
            {state.isPolling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Consultar estado de nuevo
          </Button>
          <Button onClick={state.hide} variant="tertiary">Cerrar y revisar Cashlogy</Button>
          <Button disabled={!reviewed} onClick={() => { state.closeReviewed(); setReviewedId(null) }} variant="danger">Cerrar operación revisada</Button>
        </> : null}
      </div>
    </section>
  </AppModal>
}
