import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { useCashlogyStore } from '../cashlogy/useCashlogyStore'
import type { CashlogyTransaction } from '../types'

type PaymentAction = 'retry' | 'cancel' | 'confirm' | 'finalize'

export function CashlogyPaymentModal({ error, finalizeDisabled, onCancelled, onFinalizeRecovered }: { error?: string | null; finalizeDisabled?: boolean; onCancelled?: () => void; onFinalizeRecovered: (transaction: CashlogyTransaction) => Promise<void> | void }) {
  const actionLock = useRef<{ requestId: string; type: PaymentAction } | null>(null)
  const [pendingAction, setPendingAction] = useState<{ requestId: string; type: PaymentAction } | null>(null)
  const [failure, setFailure] = useState<{ requestId: string; message: string; retryFailed: boolean } | null>(null)
  const state = useCashlogyStore(useShallow(value => ({
    modalOpen: value.modalOpen, intent: value.intent, transaction: value.transaction, error: value.error,
    isStarting: value.isStarting, isPolling: value.isPolling, isRecovering: value.isRecovering, isCancelling: value.isCancelling,
    missingTransaction: value.missingTransaction, recover: value.recover, cancelAttempt: value.cancelAttempt, confirmPaid: value.confirmPaid,
  })))
  if (!state.modalOpen || !state.intent) return null

  const intent = state.intent
  const action = pendingAction?.requestId === intent.requestId ? pendingAction.type : null
  const currentFailure = failure?.requestId === intent.requestId ? failure : null
  const terminalFailure = state.transaction && ['failed', 'cancelled', 'unknown', 'needs_attention'].includes(state.transaction.status)
  const message = currentFailure?.message ?? state.error?.message ?? error
    ?? (state.missingTransaction ? 'No se ha encontrado la operación de cobro.'
      : terminalFailure ? 'No se ha podido completar el cobro.' : null)
  const manualResolution = currentFailure?.retryFailed === true
  const busy = Boolean(action || state.isStarting || state.isPolling || state.isRecovering || state.isCancelling)
  const acceptedCents = (state.transaction?.automaticAcceptedCents ?? 0) + (state.transaction?.manualAcceptedCents ?? 0)

  const runAction = async (next: 'retry' | 'cancel' | 'confirm') => {
    const pending = actionLock.current
    if (pending?.requestId === intent.requestId && (next !== 'cancel' || pending.type !== 'retry')) return
    const operation: { requestId: string; type: PaymentAction } = { requestId: intent.requestId, type: next }
    actionLock.current = operation
    setPendingAction({ ...operation })
    const isCurrent = () => actionLock.current === operation && useCashlogyStore.getState().intent?.requestId === intent.requestId
    try {
      if (next === 'cancel') {
        await state.cancelAttempt()
        if (actionLock.current === operation) onCancelled?.()
      } else {
        const transaction = next === 'confirm' ? await state.confirmPaid()
          : state.transaction?.status === 'completed' && !intent.recoveredFromConflict ? state.transaction : await state.recover()
        if (!isCurrent()) return
        if (!transaction || transaction.status !== 'completed') throw new Error('No se ha podido recuperar el cobro.')
        operation.type = 'finalize'
        setPendingAction({ ...operation })
        await onFinalizeRecovered(transaction)
      }
    } catch (error) {
      if (!isCurrent()) return
      setFailure({ requestId: intent.requestId,
        message: error instanceof Error ? error.message : 'No se ha podido completar la operación.',
        retryFailed: next === 'retry' || manualResolution })
    } finally {
      if (actionLock.current === operation) {
        actionLock.current = null
        setPendingAction(null)
      }
    }
  }

  const retryInProgress = action === 'retry' || (!action && state.isRecovering)
  const cancelButton = <Button disabled={state.isCancelling || Boolean(action && action !== 'retry') || (!retryInProgress && (finalizeDisabled || (manualResolution && busy)))} onClick={() => void runAction('cancel')} variant="dangerSoft">Cancelar cobro</Button>

  return <AppModal dismissDisabled label="Cobro Cashlogy" maxWidth={520} onClose={() => undefined}>
    <section className="flex max-h-[calc(100dvh-48px)] w-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
        <h2 className="text-xl font-black">Cobro Cashlogy</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Metric label="Importe" value={formatMoney(intent.amountCents)} />
          <Metric label="Efectivo recibido" value={state.transaction ? formatMoney(acceptedCents) : 'Sin confirmar'} />
          {state.transaction?.returnedCents !== null && state.transaction?.returnedCents !== undefined
            ? <Metric label="Cambio" value={formatMoney(state.transaction.returnedCents)} /> : null}
        </div>
        {message ? <div role="alert" className="mt-4 flex items-start gap-3 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-5 w-5 shrink-0" /><p>{message}</p>
        </div> : <p className="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {action === 'cancel' ? 'Cancelando cobro…' : action === 'confirm' || action === 'finalize' ? 'Registrando pago…'
            : action === 'retry' || state.isRecovering ? 'Recuperando cobro…'
              : state.transaction?.status === 'waiting_for_cash' ? 'Introduce el efectivo en Cashlogy.'
                : state.transaction?.status === 'completed' ? 'Registrando pago…' : 'Procesando cobro…'}
        </p>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--separator)] bg-[var(--surface)] p-4">
        {retryInProgress || action === 'cancel' || action === 'finalize' ? cancelButton : manualResolution ? <>
          {cancelButton}
          <Button disabled={busy || finalizeDisabled} onClick={() => void runAction('confirm')} variant="primary">Marcar como pagado</Button>
        </> : message || state.transaction?.status === 'completed' ? <Button disabled={busy || finalizeDisabled} onClick={() => void runAction('retry')} variant="primary">Reintentar</Button>
          : cancelButton}
      </div>
    </section>
  </AppModal>
}
