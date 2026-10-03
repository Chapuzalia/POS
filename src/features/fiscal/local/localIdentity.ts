import { openLedger, request, transactionDone, assertInstallationBinding } from './localLedger.ts'
import type { LocalFiscalEntry } from './localLedger.ts'
import { canonicalRecordSchema } from './canonical.ts'
import { aeatHash } from './verifactu.ts'
import { UserFacingError } from '../../../utils/UserFacingError.ts'

// Namespaced metadata in the existing bindings store avoids upgrading the ledger
// database version and keeps older PWAs able to synchronize their pending entries.
const identityScope = (key: string) => `pwa-identity:${key}`
const activationScope = (key: string) => `pwa-activation:${key}`

export class FiscalIdentityMissingError extends Error {
  constructor() { super('Esta PWA no tiene una identidad fiscal local. Activa una instalación antes de emitir.') }
}

export async function readFiscalIdentity(key: string): Promise<unknown | null> {
  const db = await openLedger()
  try {
    const tx = db.transaction('bindings', 'readonly')
    const done = transactionDone(tx)
    const row = await request(tx.objectStore('bindings').get(identityScope(key))) as { snapshot: unknown } | undefined
    await done
    return row ? row.snapshot : null
  } finally { db.close() }
}

/** Persist the retry token BEFORE contacting the server. A failed read never means absence. */
export async function fiscalActivationRequest(key: string, expectedInstallationId: string | null, recoverForTesting: boolean): Promise<{ requestId: string; expectedInstallationId: string | null }> {
  const db = await openLedger()
  try {
    const tx = db.transaction('bindings', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('bindings')
    const pending = await request(store.get(activationScope(key))) as { requestId: string; expectedInstallationId: string | null; recoverForTesting: boolean } | undefined
    if (pending) {
      await done
      if (pending.recoverForTesting !== recoverForTesting) throw new UserFacingError('Hay una activación pendiente. Reintenta la misma opción para recuperar su resultado sin duplicar instalaciones.')
      return pending
    }
    const requestId = crypto.randomUUID()
    store.add({ scope: activationScope(key), requestId, expectedInstallationId, recoverForTesting })
    await done
    return { requestId, expectedInstallationId }
  } finally { db.close() }
}

export async function persistFiscalIdentity(key: string, snapshot: unknown, scope: string, deviceId: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['bindings', 'cursors', 'entries'], 'readwrite')
    const done = transactionDone(tx)
    const binding = await request(tx.objectStore('bindings').get(scope)) as { scope: string; deviceId: string } | undefined
    assertInstallationBinding(binding, deviceId)
    const cursor = await request(tx.objectStore('cursors').get(scope))
    const count = await request(tx.objectStore('entries').index('scope').count(scope))
    if (!cursor && count) { tx.abort(); throw new UserFacingError('El ledger necesita conciliación; no se puede reiniciar su cadena.') }
    if (!cursor) tx.objectStore('cursors').add({ scope, position: 0, previous: null })
    if (!binding) tx.objectStore('bindings').add({ scope, deviceId })
    tx.objectStore('bindings').put({ scope: identityScope(key), snapshot })
    tx.objectStore('bindings').delete(activationScope(key))
    await done
  } finally { db.close() }
}

/** Verify the stored chain and every series cursor; never manufacture missing cursors. */
export async function assertFiscalLedgerValid(scope: string, deviceId: string, legacyIdentity = false, installationNumber?: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['bindings', 'cursors', 'numbers', 'entries', 'delivery'], 'readonly')
    const done = transactionDone(tx)
    const binding = await request(tx.objectStore('bindings').get(scope)) as { scope: string; deviceId: string } | undefined
    const cursor = await request(tx.objectStore('cursors').get(scope)) as { position: number; previous: { issuerNif: string; seriesAndNumber: string; issueDate: string; hash: string } | null } | undefined
    const entries = (await request(tx.objectStore('entries').index('scope').getAll(scope)) as LocalFiscalEntry[])
      .sort((a, b) => a.record.chainPosition - b.record.chainPosition)
    const storedNumbers = await request(tx.objectStore('numbers').getAll(IDBKeyRange.bound(`${scope}:`, `${scope}:\uffff`))) as { key: string; lastNumber: number }[]
    const numbers = new Map<string, number>()
    let previousHash: string | undefined
    let valid = Boolean(binding && cursor && cursor.position === entries.length)
    assertInstallationBinding(binding, deviceId)
    for (const [index, entry] of entries.entries()) {
      valid &&= entry.record.chainPosition === index + 1 && entry.record.previous?.hash === previousHash
        && entry.record.deviceId === deviceId && entry.scope === scope
        && `${entry.record.tenantId}:${entry.record.fiscalSubjectId}:${entry.record.installationId}` === scope
        && entry.id === entry.record.idempotencyKey && entry.record.environment === 'production'
        && Boolean(await request(tx.objectStore('delivery').get(entry.id)))
      previousHash = entry.record.hash
      if (!entry.annulment) {
        valid &&= entry.invoice.number === (numbers.get(entry.invoice.series) ?? 0) + 1
        numbers.set(entry.invoice.series, entry.invoice.number)
      }
    }
    valid &&= (cursor?.previous?.hash ?? undefined) === previousHash
    for (const [series, lastNumber] of numbers) {
      const number = await request(tx.objectStore('numbers').get(`${scope}:${series}`)) as { lastNumber: number } | undefined
      valid &&= number?.lastNumber === lastNumber
    }
    valid &&= storedNumbers.length === numbers.size
    await done
    // Web Crypto must run after the IDB transaction has finished; it yields to the event loop.
    let previousIdentity: { issuerNif: string; seriesAndNumber: string; issueDate: string; hash: string } | null = null
    for (const entry of entries) {
      const canonical = canonicalRecordSchema.parse(entry.record.canonicalRecord)
      const root = 'RegistroAlta' in canonical ? canonical.RegistroAlta : canonical.RegistroAnulacion
      const identity = root.IDFactura
      const seriesAndNumber = 'NumSerieFactura' in identity ? identity.NumSerieFactura : identity.NumSerieFacturaAnulada
      const issueDate = 'FechaExpedicionFactura' in identity ? identity.FechaExpedicionFactura : identity.FechaExpedicionFacturaAnulada
      const issuerNif = 'IDEmisorFactura' in identity ? identity.IDEmisorFactura : identity.IDEmisorFacturaAnulada
      const base = { issuerNif, seriesAndNumber, issueDate, previousHash: entry.record.previous?.hash ?? null, generatedAt: entry.record.generatedAt }
      const hash = await aeatHash('RegistroAlta' in canonical
        ? { ...base, kind: 'alta', invoiceType: canonical.RegistroAlta.TipoFactura, taxTotal: canonical.RegistroAlta.CuotaTotal, invoiceTotal: canonical.RegistroAlta.ImporteTotal }
        : { ...base, kind: 'anulacion' })
      valid &&= hash === entry.record.hash && root.Huella === hash
        && (seriesAndNumber === `${entry.invoice.series}/${entry.invoice.number}`
          || (legacyIdentity && seriesAndNumber === `${entry.invoice.series}${entry.invoice.number}`))
        && root.FechaHoraHusoGenRegistro === entry.record.generatedAt
        && (installationNumber === undefined || root.SistemaInformatico.NumeroInstalacion === installationNumber)
      if (previousIdentity) {
        const previous = 'RegistroAnterior' in root.Encadenamiento ? root.Encadenamiento.RegistroAnterior : null
        valid &&= previous?.IDEmisorFactura === previousIdentity.issuerNif
          && previous?.NumSerieFactura === previousIdentity.seriesAndNumber && previous?.FechaExpedicionFactura === previousIdentity.issueDate
          && previous?.Huella === previousIdentity.hash && entry.record.previous?.issuerNif === previousIdentity.issuerNif
          && entry.record.previous?.seriesAndNumber === previousIdentity.seriesAndNumber && entry.record.previous?.issueDate === previousIdentity.issueDate
      } else valid &&= 'PrimerRegistro' in root.Encadenamiento && root.Encadenamiento.PrimerRegistro === 'S'
      previousIdentity = { issuerNif, seriesAndNumber, issueDate, hash }
    }
    if (previousIdentity) valid &&= cursor?.previous?.issuerNif === previousIdentity.issuerNif
      && cursor?.previous?.seriesAndNumber === previousIdentity.seriesAndNumber && cursor?.previous?.issueDate === previousIdentity.issueDate
    if (!valid) throw new UserFacingError('La identidad existe pero el ledger fiscal está incompleto. Requiere recuperación o conciliación; se bloquea la emisión.')
  } finally { db.close() }
}

/** Only discard a retry token after the server explicitly confirms no usable activation. */
export async function clearFiscalActivationRequest(key: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('bindings', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('bindings').delete(activationScope(key))
    await done
  } finally { db.close() }
}
