import { AlertTriangle, Ban, CheckCircle2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { shouldShowCashlogyOperationDetails } from '../cashlogy/cashlogyPresentation'
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
  const [finalizationError, setFinalizationError] = useState<{ requestId: string; message: string } | null>(null)
  const state = useCashlogyStore(useShallow((value) => ({
    modalOpen: value.modalOpen,
    intent: value.intent,
    transaction: value.transaction,
    levels: value.levels,
    error: value.error,
    isStarting: value.isStarting,
    isPolling: value.isPolling,
    isCancelling: value.isCancelling,
    isRecovering: value.isRecovering,
    missingTransaction: value.missingTransaction,
    cancel: value.cancel,
    recover: value.recover,
    retryPayment: value.retryPayment,
  })))
  const acceptedCents = (state.transaction?.automaticAcceptedCents ?? 0) + (state.transaction?.manualAcceptedCents ?? 0)

  if (!state.modalOpen || !state.intent) return null

  const status = state.transaction?.status
  const interruptedBeforeRequest = !state.transaction && state.intent.chargeRequestedAt === null && !state.isStarting
  const reviewKey = state.transaction?.id ?? state.intent.requestId
  const reviewed = reviewedId === reviewKey
  const previousCompleted = status === 'completed' && state.intent.recoveredFromConflict
  const critical = status === 'unknown' || status === 'needs_attention' || previousCompleted || state.missingTransaction
  const startFailed = !state.transaction && Boolean(state.error) && !state.isStarting && !state.isPolling
  const busy = Boolean(state.isStarting || state.isPolling || state.isRecovering || state.isCancelling)
  const showOperationDetails = shouldShowCashlogyOperationDetails(status)

  const finalizeRecovered = async () => {
    if (!state.transaction || isFinalizing) return
    setFinalizationError(null)
    setIsFinalizing(true)
    try {
      await onFinalizeRecovered(state.transaction)
    } catch (error) {
      setFinalizationError({ requestId: state.transaction.requestId, message: error instanceof Error ? error.message : 'No se ha podido registrar el cobro. El cobro sigue pendiente; puedes volver a aplicar el resultado confirmado.' })
    } finally {
      setIsFinalizing(false)
    }
  }

  const retryReviewedPayment = async () => {
    const intent = state.intent
    if (!intent || (critical && !reviewed) || isFinalizing || busy) return
    setFinalizationError(null)
    try {
      const transaction = await state.retryPayment(reviewed)
      setIsFinalizing(true)
      await onFinalizeRecovered(transaction)
    } catch (error) {
      setFinalizationError({ requestId: intent.requestId, message: error instanceof Error ? error.message : 'No se ha podido completar el nuevo intento.' })
    } finally {
      setIsFinalizing(false)
    }
  }

  const cancelPayment = () => {
    const closingAcceptance = status === 'finalizing_acceptance' || status === 'dispensing_change' || status === 'processing'
    const requiresReview = critical || status === 'completed' || closingAcceptance
    if (requiresReview && !reviewed && !window.confirm(closingAcceptance
      ? 'Cashlogy ya está terminando el movimiento de efectivo y no puede interrumpirlo. Se esperará al resultado antes de cerrar este intento. Cancelar no devuelve dinero ni registra una venta: comprueba el efectivo. ¿Quieres continuar?'
      : 'Comprueba la máquina y el efectivo antes de continuar. Cancelar este intento no devuelve dinero ni registra una venta. ¿Has revisado el efectivo y quieres cancelar el intento?')) return
    void state.cancel(requiresReview).catch(() => undefined)
  }

  return <AppModal dismissDisabled label="Cobro Cashlogy" maxWidth={520} onClose={() => undefined}>
    <section className="flex max-h-[calc(100dvh-48px)] w-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
      <div className={`flex items-start gap-3 rounded-[var(--radius)] border p-4 ${critical ? 'border-red-500 bg-red-500/10' : 'border-[var(--separator)] bg-[var(--background)]'}`}>
        {critical ? <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
          : status === 'completed' ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
            : status === 'cancelled' || status === 'failed' || startFailed ? <Ban className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
              : <LoaderCircle className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-[var(--accent)]" />}
        <div>
          <h2 className="text-xl font-black">{state.isCancelling
            ? 'Cancelando cobro…'
            : state.missingTransaction
              ? 'Operación no encontrada en el agente'
            : interruptedBeforeRequest
              ? 'Cobro no enviado a Cashlogy'
            : status
              ? statusLabels[status]
              : startFailed
                ? 'No se pudo iniciar el cobro'
                : state.isStarting
                  ? 'Conectando con Cashlogy…'
                  : 'Recuperando operación'}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {state.isCancelling
              ? 'Espera a que el agente confirme la cancelación o termine el movimiento de efectivo. Después volverás al TPV.'
              : interruptedBeforeRequest
              ? 'El inicio se interrumpió antes de solicitar el cobro. Cancela este intento para volver al TPV.'
              : state.missingTransaction
              ? 'El agente ha confirmado que no conoce esta operación. Revisa el efectivo antes de crear otro cobro; no se intentará recuperar una operación inexistente.'
              : critical
              ? 'No repitas el cobro. Comprueba físicamente la máquina y revisa la operación con el responsable de caja.'
              : startFailed
                ? 'Revisa el mensaje de error antes de volver al pago.'
              : status === 'waiting_for_cash'
                ? 'Introduce billetes y monedas en Cashlogy. Para salir, cancela el cobro.'
                : state.isStarting
                  ? 'Espera mientras se comprueba la máquina. El cobro ya está bloqueado para evitar duplicados.'
                  : status === 'completed'
                    ? 'La máquina ha confirmado el cobro. Aplica el resultado para registrar la venta.'
                    : 'Consulta el estado o cancela este intento para volver al TPV.'}
          </p>
        </div>
      </div>

      {showOperationDetails ? <>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Metric label="Importe solicitado" value={formatMoney(state.intent.amountCents)} />
          <Metric label="Efectivo aceptado" value={state.transaction ? formatMoney(acceptedCents) : 'Sin confirmar'} />
          {state.transaction?.returnedCents !== null && state.transaction?.returnedCents !== undefined
            ? <Metric label="Cambio devuelto" value={formatMoney(state.transaction.returnedCents)} />
            : null}
          {state.transaction?.netPaidCents !== null && state.transaction?.netPaidCents !== undefined
            ? <Metric label="Neto pagado" value={formatMoney(state.transaction.netPaidCents)} />
            : null}
        </div>

        <CashlogyLevelCards levels={state.levels} variant="payment" />
      </> : null}

      {state.error || finalizationError?.requestId === state.intent.requestId ? <div role="alert" className="mt-4 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm">
        <p className="font-bold text-red-700 dark:text-red-300">{finalizationError?.requestId === state.intent.requestId ? finalizationError.message : state.error?.message}</p>
      </div> : null}

        {critical ? <label className="w-full text-sm">
          <input type="checkbox" checked={reviewed} onChange={(event) => setReviewedId(event.target.checked ? reviewKey : null)} className="mr-2" />
          He revisado la máquina y el efectivo con el responsable de caja. Entiendo que «Marcar como cobrado» puede registrar una venta no cobrada y que «Volver a cobrar» puede duplicar un cobro.
        </label> : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--separator)] bg-[var(--surface)] p-4">
        {!state.isStarting && !state.isPolling && !interruptedBeforeRequest ? <Button disabled={state.isRecovering || state.isCancelling || isFinalizing} onClick={() => void state.recover().catch(() => undefined)}>Consultar estado</Button> : null}
        <Button disabled={state.isCancelling || isFinalizing} onClick={cancelPayment} variant="dangerSoft">
          {state.isCancelling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Cancelar cobro
        </Button>
        {status === 'completed' && state.transaction && !previousCompleted ? <Button disabled={finalizeDisabled || isFinalizing} onClick={() => void finalizeRecovered()} variant="primary">
          {isFinalizing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {isFinalizing ? 'Registrando venta…' : 'Aplicar cobro confirmado'}
        </Button> : null}
        {status === 'failed' || status === 'cancelled' || (startFailed && !critical) ? <Button disabled={busy || isFinalizing} onClick={() => void retryReviewedPayment()} variant="primary">Volver a cobrar</Button> : null}
        {critical ? <>
          {state.transaction ? <Button disabled={!reviewed || finalizeDisabled || isFinalizing || busy} onClick={() => void finalizeRecovered()} variant="primary">
            {isFinalizing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {isFinalizing ? 'Marcando como cobrado…' : 'Marcar como cobrado'}
          </Button> : null}
          <Button disabled={!reviewed || finalizeDisabled || isFinalizing || busy} onClick={() => void retryReviewedPayment()} variant="danger">Volver a cobrar</Button>
        </> : null}
      </div>
    </section>
  </AppModal>
}
