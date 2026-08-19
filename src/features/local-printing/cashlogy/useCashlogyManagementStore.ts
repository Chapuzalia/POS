import { create } from 'zustand'
import { createPrintAgentClient } from '../api/printAgentClient'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type {
  CashlogyAvailableDenomination,
  CashlogyCashManagementOperation,
  CashlogyCashManagementType,
  CashlogyManagementIntent,
  CashlogyOperationResponse,
  CashlogyRequestedDenomination,
  PrintAgentScope,
} from '../types'
import { CashlogyError, isUncertainCashlogyError, toCashlogyError } from './cashlogyError'
import { createCashlogyRequestId } from './cashlogyRequestId'
import {
  cashlogyManagementActiveStatuses,
  cashlogyManagementCancellableStatuses,
  pollCashlogyOperation,
} from './cashlogyPolling'
import { loadCashlogyIntent, loadCashlogyManagementIntent, saveCashlogyManagementIntent } from './cashlogyStorage'

export type CashlogyManagementState = {
  scope: PrintAgentScope | null
  intent: CashlogyManagementIntent | null
  operation: CashlogyCashManagementOperation | null
  error: CashlogyError | null
  modalOpen: boolean
  isStarting: boolean
  isPolling: boolean
  isMutating: boolean
  isCancelling: boolean
  configureScope: (scope: PrintAgentScope) => void
  open: () => void
  hide: () => void
  startRefill: () => Promise<CashlogyCashManagementOperation>
  startGiveChange: (denominationOptions: CashlogyAvailableDenomination[]) => Promise<CashlogyCashManagementOperation>
  withdraw: (denominations: CashlogyRequestedDenomination[]) => Promise<CashlogyCashManagementOperation>
  empty: () => Promise<CashlogyCashManagementOperation>
  collectStacker: () => Promise<CashlogyCashManagementOperation>
  finalizeRefill: () => Promise<CashlogyCashManagementOperation>
  finalizeGiveChangeAdmission: () => Promise<CashlogyCashManagementOperation>
  dispenseGiveChange: (denominations: CashlogyRequestedDenomination[]) => Promise<CashlogyCashManagementOperation>
  cancel: (signal?: AbortSignal) => Promise<CashlogyCashManagementOperation>
  recover: (signal?: AbortSignal) => Promise<CashlogyCashManagementOperation | null>
  clearResolved: () => void
  clearError: () => void
}

let startPromise: Promise<CashlogyCashManagementOperation> | null = null
let recoveryPromise: Promise<CashlogyCashManagementOperation | null> | null = null
let operationPollingController: AbortController | null = null
let operationPollingGeneration = 0

function client() {
  const print = usePrintAgentStore.getState()
  return createPrintAgentClient({ baseUrl: print.baseUrl, token: print.token })
}

function persistIntent(intent: CashlogyManagementIntent | null) {
  const scope = useCashlogyManagementStore.getState().scope
  if (scope) saveCashlogyManagementIntent(scope, intent)
}

function operationError(operation: CashlogyCashManagementOperation) {
  if (operation.status === 'unknown') return new CashlogyError({
    code: 'CASHLOGY_STATUS_UNKNOWN',
    originalCode: operation.normalizedErrorCode ?? operation.error?.code,
    details: operation,
  })
  if (operation.status === 'needs_attention') return new CashlogyError({
    code: 'CASHLOGY_RECONCILIATION_MISMATCH',
    originalCode: operation.normalizedErrorCode ?? operation.error?.code,
    details: operation,
  })
  if (operation.status === 'failed') return new CashlogyError({
    code: 'CASHLOGY_OPERATION_FAILED',
    originalCode: operation.normalizedErrorCode ?? operation.error?.code,
    details: operation,
  })
  if (operation.status === 'cancelled') return null
  return null
}

function identifyOperation(operation: CashlogyCashManagementOperation) {
  const state = useCashlogyManagementStore.getState()
  const intent = state.intent && state.intent.operationId !== operation.id
    ? { ...state.intent, operationId: operation.id }
    : state.intent
  if (intent !== state.intent) persistIntent(intent)
  useCashlogyManagementStore.setState({
    intent,
    operation,
    error: operationError(operation),
  })
}

function shouldPoll(operation: CashlogyCashManagementOperation) {
  return cashlogyManagementActiveStatuses.has(operation.status)
    && !(operation.type === 'give_change' && operation.status === 'awaiting_dispense')
}

function readOperation(operation: CashlogyCashManagementOperation, signal?: AbortSignal) {
  const activeClient = client()
  if (operation.type === 'refill') return activeClient.getCashlogyRefill(operation.id, signal)
  if (operation.type === 'give_change') return activeClient.getCashlogyGiveChange(operation.id, signal)
  return activeClient.getCashlogyCashManagementOperationByRequestId(operation.requestId, signal)
}

function stopPolling() {
  operationPollingGeneration += 1
  operationPollingController?.abort()
  operationPollingController = null
  useCashlogyManagementStore.setState({ isPolling: false })
}

function startPolling(operation: CashlogyCashManagementOperation) {
  stopPolling()
  if (!shouldPoll(operation)) return
  const generation = operationPollingGeneration
  const controller = new AbortController()
  operationPollingController = controller
  useCashlogyManagementStore.setState({ isPolling: true })
  void pollCashlogyOperation(readOperation, operation, {
    signal: controller.signal,
    shouldContinue: shouldPoll,
    onUpdate: (next) => {
      if (generation === operationPollingGeneration) identifyOperation(next)
    },
  }).then((terminal) => {
    if (generation === operationPollingGeneration) identifyOperation(terminal)
  }).catch((error) => {
    if (controller.signal.aborted || generation !== operationPollingGeneration) return
    useCashlogyManagementStore.setState({ error: toCashlogyError(error) })
  }).finally(() => {
    if (generation === operationPollingGeneration) {
      operationPollingController = null
      useCashlogyManagementStore.setState({ isPolling: false })
    }
  })
}

function uncertainOperationError(error: unknown) {
  return new CashlogyError({
    code: 'CASHLOGY_STATUS_UNKNOWN',
    originalCode: error instanceof Error && 'code' in error ? String(error.code) : null,
    details: error,
  })
}

async function recoverAfterUncertainResult(requestId: string, originalError: unknown) {
  try {
    return (await client().getCashlogyCashManagementOperationByRequestId(requestId)).operation
  } catch {
    throw uncertainOperationError(originalError)
  }
}

async function createOperation(
  type: CashlogyCashManagementType,
  createRequest: (requestId: string) => Promise<CashlogyOperationResponse>,
  denominationOptions?: CashlogyAvailableDenomination[],
) {
  const state = useCashlogyManagementStore.getState()
  if (state.intent || state.isStarting || state.isMutating) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
  if (!usePrintAgentStore.getState().cashlogyConfigured) throw new CashlogyError({ code: 'CASHLOGY_NOT_CONFIGURED' })
  if (state.scope && loadCashlogyIntent(state.scope)) {
    throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'Hay un cobro Cashlogy pendiente de resolución.' })
  }
  const intent: CashlogyManagementIntent = {
    requestId: createCashlogyRequestId(type),
    type,
    operationId: null,
    ...(denominationOptions?.length ? { denominationOptions } : {}),
    createdAt: new Date().toISOString(),
  }
  persistIntent(intent)
  useCashlogyManagementStore.setState({ intent, operation: null, error: null, modalOpen: true, isStarting: true })
  try {
    let operation: CashlogyCashManagementOperation
    try {
      operation = (await createRequest(intent.requestId)).operation
    } catch (error) {
      if (!isUncertainCashlogyError(error)) {
        persistIntent(null)
        useCashlogyManagementStore.setState({ intent: null })
        throw error
      }
      operation = await recoverAfterUncertainResult(intent.requestId, error)
    }
    identifyOperation(operation)
    startPolling(operation)
    return operation
  } catch (error) {
    const mapped = toCashlogyError(error, isUncertainCashlogyError(error) ? 'CASHLOGY_STATUS_UNKNOWN' : 'CASHLOGY_OPERATION_FAILED')
    useCashlogyManagementStore.setState({ error: mapped })
    throw mapped
  } finally {
    useCashlogyManagementStore.setState({ isStarting: false })
  }
}

async function mutateOperation(
  mutate: (operation: CashlogyCashManagementOperation) => Promise<CashlogyOperationResponse>,
) {
  const current = useCashlogyManagementStore.getState().operation
  if (!current || useCashlogyManagementStore.getState().isMutating) throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE' })
  stopPolling()
  useCashlogyManagementStore.setState({ isMutating: true, error: null })
  try {
    let operation: CashlogyCashManagementOperation
    try {
      operation = (await mutate(current)).operation
    } catch (error) {
      if (!isUncertainCashlogyError(error)) throw error
      operation = await recoverAfterUncertainResult(current.requestId, error)
    }
    identifyOperation(operation)
    startPolling(operation)
    return operation
  } catch (error) {
    const mapped = toCashlogyError(error, isUncertainCashlogyError(error) ? 'CASHLOGY_STATUS_UNKNOWN' : 'CASHLOGY_OPERATION_FAILED')
    useCashlogyManagementStore.setState({ error: mapped })
    throw mapped
  } finally {
    useCashlogyManagementStore.setState({ isMutating: false })
  }
}

export const useCashlogyManagementStore = create<CashlogyManagementState>((set, get) => ({
  scope: null,
  intent: null,
  operation: null,
  error: null,
  modalOpen: false,
  isStarting: false,
  isPolling: false,
  isMutating: false,
  isCancelling: false,

  configureScope(scope) {
    stopPolling()
    startPromise = null
    recoveryPromise = null
    const intent = loadCashlogyManagementIntent(scope)
    set({ scope, intent, operation: null, error: null, modalOpen: Boolean(intent), isStarting: false, isPolling: false, isMutating: false, isCancelling: false })
  },

  open() { set({ modalOpen: true }) },

  hide() {
    set({ modalOpen: false })
  },

  async startRefill() {
    if (!startPromise) startPromise = createOperation('refill', (requestId) => client().startCashlogyRefill(requestId)).finally(() => { startPromise = null })
    return startPromise
  },

  async startGiveChange(denominationOptions) {
    if (!denominationOptions.length) {
      throw new CashlogyError({
        code: 'CASHLOGY_INVALID_STATE',
        message: 'No se han podido cargar las denominaciones dispensables antes de iniciar la operación.',
      })
    }
    if (!startPromise) startPromise = createOperation(
      'give_change',
      (requestId) => client().startCashlogyGiveChange(requestId),
      denominationOptions,
    ).finally(() => { startPromise = null })
    return startPromise
  },

  async withdraw(denominations) {
    if (!startPromise) startPromise = createOperation('withdraw', (requestId) => client().withdrawCashlogyCash(requestId, denominations)).finally(() => { startPromise = null })
    return startPromise
  },

  async empty() {
    if (!startPromise) startPromise = createOperation('empty', (requestId) => client().emptyCashlogy(requestId)).finally(() => { startPromise = null })
    return startPromise
  },

  async collectStacker() {
    if (!startPromise) startPromise = createOperation('remove_stacker', (requestId) => client().collectCashlogyStacker(requestId)).finally(() => { startPromise = null })
    return startPromise
  },

  finalizeRefill() {
    return mutateOperation((operation) => client().finalizeCashlogyRefill(operation.id))
  },

  finalizeGiveChangeAdmission() {
    return mutateOperation((operation) => client().finalizeCashlogyGiveChangeAdmission(operation.id))
  },

  dispenseGiveChange(denominations) {
    return mutateOperation((operation) => client().dispenseCashlogyGiveChange(operation.id, denominations))
  },

  async cancel(signal) {
    const state = get()
    const current = state.operation
    if (state.isCancelling || state.isStarting || state.isMutating) {
      throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    }
    if (!current || !cashlogyManagementCancellableStatuses.has(current.status)) {
      throw new CashlogyError({
        code: 'CASHLOGY_CASH_MANAGEMENT_NOT_ACTIVE',
        message: 'Cashlogy ya no admite cancelar esta fase de la operación.',
      })
    }

    stopPolling()
    set({ isCancelling: true, error: null })
    try {
      const response = await client().cancelActiveCashlogyOperation(signal)
      if (response.target && (response.target.kind !== 'cash_management' || response.target.id !== current.id)) {
        throw new CashlogyError({
          code: 'CASHLOGY_INVALID_STATE',
          message: 'El backend ha identificado otra operación monetaria activa. Revisa su estado antes de continuar.',
          details: response,
        })
      }
      const operation = (await client().getCashlogyCashManagementOperationByRequestId(current.requestId, signal)).operation
      identifyOperation(operation)
      if (!response.cancelled && cashlogyManagementActiveStatuses.has(operation.status)) {
        throw new CashlogyError({
          code: 'CASHLOGY_CASH_MANAGEMENT_NOT_ACTIVE',
          message: 'La máquina no ha confirmado la cancelación de esta operación.',
          details: response,
        })
      }
      startPolling(operation)
      return operation
    } catch (error) {
      const mapped = toCashlogyError(error)
      set({ error: mapped })
      const operation = get().operation
      if (operation) startPolling(operation)
      throw mapped
    } finally {
      set({ isCancelling: false })
    }
  },

  async recover(signal) {
    if (recoveryPromise) return recoveryPromise
    const intent = get().intent
    if (!intent) return null
    set({ modalOpen: true, error: null })
    recoveryPromise = (async () => {
      try {
        const operation = (await client().getCashlogyCashManagementOperationByRequestId(intent.requestId, signal)).operation
        identifyOperation(operation)
        startPolling(operation)
        return operation
      } catch (error) {
        const mapped = toCashlogyError(error)
        set({ error: mapped })
        throw mapped
      }
    })().finally(() => { recoveryPromise = null })
    return recoveryPromise
  },

  clearResolved() {
    const operation = get().operation
    if (!operation || cashlogyManagementActiveStatuses.has(operation.status)) return
    if (operation.status === 'unknown' || operation.status === 'needs_attention') return
    stopPolling()
    persistIntent(null)
    set({ intent: null, operation: null, error: null, modalOpen: false, isCancelling: false })
  },

  clearError() { set({ error: null }) },
}))
