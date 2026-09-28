import { BridgeHttpError, type BridgeSubmission, type BridgeResult } from './bridgeClient.ts'
import { createBridgeClient } from './bridgeClient.ts'
import { listLocalFiscalEntries, updateLocalFiscalDelivery, type LocalFiscalEntry } from './localLedger.ts'

export type FiscalScope = { tenantId: string; fiscalSubjectId: string; installationId: string }
export type FiscalSyncConfig = FiscalScope & { mode: 'test' | 'production'; baseUrl: string; getAccessToken: () => Promise<string> }

const terminal = new Set<BridgeResult['state']>(['AEAT_ACCEPTED', 'AEAT_ACCEPTED_WITH_ERRORS', 'AEAT_REJECTED'])

function nextRetry(attempts: number, retryAfterSeconds?: number): string {
  const seconds = retryAfterSeconds ?? Math.min(900, 5 * 2 ** Math.min(attempts, 8))
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export function summarizeLocalFiscalQueue(entries: readonly LocalFiscalEntry[], now = Date.now()) {
  const states = {
    LOCAL_PENDING: 0, VPS_STORED: 0, AEAT_ACCEPTED: 0,
    AEAT_ACCEPTED_WITH_ERRORS: 0, AEAT_REJECTED: 0, REQUIRES_ACTION: 0,
  }
  let oldestPendingMinutes: number | null = null
  for (const entry of entries) {
    states[entry.delivery.state] += 1
    if (entry.delivery.state === 'LOCAL_PENDING' || entry.delivery.state === 'VPS_STORED') {
      const minutes = Math.max(0, Math.floor((now - Date.parse(entry.record.generatedAt)) / 60000))
      oldestPendingMinutes = Math.max(oldestPendingMinutes ?? 0, minutes)
    }
  }
  return { states, oldestPendingMinutes }
}

export function deliveryFromResult(entry: LocalFiscalEntry, result: BridgeResult): LocalFiscalEntry['delivery'] {
  if (result.idempotencyKey !== entry.id) throw new Error('El puente respondió sobre otro registro fiscal.')
  if (result.state === 'LOCAL_PENDING') throw new Error('El puente no puede confirmar un estado exclusivamente local.')
  if (!result.vpsStoredAt) throw new Error('Falta el acuse durable del VPS.')
  if (result.state.startsWith('AEAT_') && !result.aeatRespondedAt) throw new Error('Falta la fecha de respuesta AEAT.')
  if ((result.state === 'AEAT_ACCEPTED_WITH_ERRORS' || result.state === 'AEAT_REJECTED') && (!result.code || !result.description)) {
    throw new Error('Falta el código o la descripción del resultado AEAT.')
  }
  if (entry.delivery.state !== 'LOCAL_PENDING' && result.state === 'VPS_STORED' && terminal.has(entry.delivery.state)) {
    throw new Error('El puente intentó retroceder un estado fiscal final.')
  }
  return {
    state: result.state,
    attempts: entry.delivery.attempts + 1,
    lastError: result.state === 'AEAT_REJECTED' || result.state === 'REQUIRES_ACTION' ? result.description : null,
    nextAttemptAt: result.state === 'VPS_STORED' || result.state === 'REQUIRES_ACTION'
      ? nextRetry(entry.delivery.attempts, result.retryAfterSeconds ?? (result.state === 'REQUIRES_ACTION' ? 300 : undefined)) : null,
    result,
  }
}

export async function resolvePendingBridgeRecord(
  client: Pick<ReturnType<typeof createBridgeClient>, 'status' | 'deliver'>,
  record: BridgeSubmission,
): Promise<BridgeResult> {
  try {
    return await client.status(record.idempotencyKey)
  } catch (error) {
    if (!(error instanceof BridgeHttpError) || error.status !== 404) throw error
    return (await client.deliver([record]))[0]
  }
}

/** Runs only while the PWA is open. The bridge must retry its own durably stored records. */
export async function synchronizeLocalFiscalQueue(config: FiscalSyncConfig): Promise<void> {
  const scope = `${config.tenantId}:${config.fiscalSubjectId}:${config.installationId}`
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible para sincronizar la cola fiscal.')
  await navigator.locks.request(`tickit-fiscal-sync:${scope}`, { mode: 'exclusive' }, async () => {
    const entries = await listLocalFiscalEntries(config)
    const client = createBridgeClient({ mode: config.mode, baseUrl: config.baseUrl, getAccessToken: config.getAccessToken })
    for (const entry of entries) {
      if (terminal.has(entry.delivery.state)) continue
      if (entry.delivery.nextAttemptAt && Date.parse(entry.delivery.nextAttemptAt) > Date.now()) continue
      try {
        const result = entry.delivery.state === 'LOCAL_PENDING'
          ? await resolvePendingBridgeRecord(client, { ...entry.record, invoice: entry.invoice })
          : await client.status(entry.id)
        await updateLocalFiscalDelivery(entry.id, deliveryFromResult(entry, result))
      } catch (error) {
        const attempts = entry.delivery.attempts + 1
        const lastError = error instanceof Error ? error.message.slice(0, 300) : 'Error de sincronización fiscal'
        await updateLocalFiscalDelivery(entry.id, { ...entry.delivery, attempts, lastError, nextAttemptAt: nextRetry(attempts) })
        // Preserve chain order: a later record cannot overtake an unacknowledged predecessor.
        if (entry.delivery.state === 'LOCAL_PENDING') break
      }
    }
  })
}

export function startFiscalSyncWhileOpen(config: FiscalSyncConfig): () => void {
  let stopped = false
  let running = false
  const run = () => {
    if (stopped || running || document.visibilityState === 'hidden') return
    running = true
    void synchronizeLocalFiscalQueue(config).catch(() => { /* pending records retain their state for the next attempt */ }).finally(() => { running = false })
  }
  const timer = window.setInterval(run, 30000)
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', run)
  run()
  return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('online', run); document.removeEventListener('visibilitychange', run) }
}
