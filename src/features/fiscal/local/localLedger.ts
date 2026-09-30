import type { BridgeAnnulmentSnapshot, BridgeInvoiceSnapshot, BridgeRecord, BridgeResult } from './bridgeClient.ts'
import { createAltaRecord, createAnulacionRecord, createRectificativeRecord, type FiscalDetail, type FiscalSystem } from './canonical.ts'
import { centsToAeat } from './canonical.ts'
import { fiscalSeries } from './fiscalPolicy.ts'
import { assertFiscalClock, type FiscalClockSample } from './clock.ts'
import { assertFiscalLease, type FiscalLease } from './clock.ts'
import type { SaleCreatedPayload } from '../../../types/index.ts'

export type LocalFiscalState = BridgeResult['state']
export type LocalFiscalEntry = {
  id: string
  scope: string
  record: BridgeRecord
  invoice: BridgeInvoiceSnapshot
  annulment?: BridgeAnnulmentSnapshot
  delivery: { state: LocalFiscalState; attempts: number; lastError: string | null; nextAttemptAt: string | null; result: BridgeResult | null }
}

type Cursor = { scope: string; position: number; previous: { issuerNif: string; seriesAndNumber: string; issueDate: string; hash: string } | null }
type NumberCursor = { key: string; lastNumber: number }
type DeviceBinding = { scope: string; deviceId: string }
type StoredFiscalDocument = Omit<LocalFiscalEntry, 'delivery'>
type StoredDelivery = LocalFiscalEntry['delivery'] & { id: string }
type StoredEconomicSale = { id: string; scope: string; payload: SaleCreatedPayload; eventId: string; synced: boolean }
export type RestorableFiscalCopy = { entry: LocalFiscalEntry; economicPayload: SaleCreatedPayload | null; eventId: string | null }

const dbName = 'tickit-verifactu-local-v1'
const dbVersion = 4

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB canceló la emisión fiscal.'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB no guardó la emisión fiscal.'))
  })
  void done.catch(() => {})
  return done
}

async function openLedger(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB no está disponible. No se puede expedir.')
  const opening = indexedDB.open(dbName, dbVersion)
  opening.onupgradeneeded = () => {
    const db = opening.result
    const upgradeTx = opening.transaction
    if (!upgradeTx) throw new Error('No se pudo iniciar la migración fiscal de IndexedDB.')
    if (!db.objectStoreNames.contains('cursors')) db.createObjectStore('cursors', { keyPath: 'scope' })
    if (!db.objectStoreNames.contains('numbers')) db.createObjectStore('numbers', { keyPath: 'key' })
    if (!db.objectStoreNames.contains('bindings')) db.createObjectStore('bindings', { keyPath: 'scope' })
    const entries = db.objectStoreNames.contains('entries')
      ? upgradeTx.objectStore('entries')
      : db.createObjectStore('entries', { keyPath: 'id' })
    if (!entries.indexNames.contains('scope')) entries.createIndex('scope', 'scope')
    if (!entries.indexNames.contains('ticket')) entries.createIndex('ticket', ['scope', 'invoice.ticketId'])
    if (!db.objectStoreNames.contains('delivery')) db.createObjectStore('delivery', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('economicSales')) {
      const economicSales = db.createObjectStore('economicSales', { keyPath: 'id' })
      economicSales.createIndex('scope', 'scope')
    }
  }
  const db = await request(opening)
  db.onversionchange = () => db.close()
  return db
}

function scopeKey(input: { tenantId: string; fiscalSubjectId: string; installationId: string }): string {
  if (!input.tenantId || !input.fiscalSubjectId || !input.installationId) throw new Error('Falta el ámbito de la instalación fiscal.')
  return `${input.tenantId}:${input.fiscalSubjectId}:${input.installationId}`
}

export function assertInstallationBinding(binding: DeviceBinding | undefined, deviceId: string): void {
  if (!deviceId || (binding && binding.deviceId !== deviceId)) {
    throw new Error('La instalación SIF está vinculada a otro dispositivo; se bloquea la emisión.')
  }
}

async function loadCursors(db: IDBDatabase, scope: string, series: string): Promise<{ chain: Cursor; number: NumberCursor }> {
  const tx = db.transaction(['cursors', 'numbers'], 'readonly')
  const done = transactionDone(tx)
  const chain = await request(tx.objectStore('cursors').get(scope)) as Cursor | undefined
  const number = await request(tx.objectStore('numbers').get(`${scope}:${series}`)) as NumberCursor | undefined
  await done
  return { chain: chain ?? { scope, position: 0, previous: null }, number: number ?? { key: `${scope}:${series}`, lastNumber: 0 } }
}

type IssueInputBase = {
  tenantId: string; fiscalSubjectId: string; issuerNif: string; issuerName: string; issuerAddress?: string
  venueId: string; venueCode: string; cashRegisterId: string; registerCode: string; installationCode: string
  installationId: string; deviceId: string; ticketId: string; saleId: string; paymentId: string | null
  installationNumber?: string
  invoiceId: string; invoiceType: 'F1' | 'F2'; recipient?: { name: string; nif: string }
  description: string; system: FiscalSystem; timezone: string
  clockSample?: FiscalClockSample
  qrEnvironment?: 'test' | 'production'
  lines: readonly { description: string; grossCents: number; discountCents: number; baseCents: number; taxCents: number; taxRate: string }[]
}

export type TestIssueInput = IssueInputBase & { environment: 'test'; syntheticData: true }
export type ProductionIssueInput = IssueInputBase & {
  environment: 'production'; lease: FiscalLease; transmissionMode: 'bridge' | 'local-only'
  salePayload: SaleCreatedPayload; economicAlreadySynced?: boolean
}
export type LocalIssueInput = TestIssueInput | ProductionIssueInput
export type ResolveFiscalSale = (draft: LocalFiscalEntry) => Promise<SaleCreatedPayload>

export function localDateParts(now: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' })
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]))
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(parts.timeZoneName ?? '')
  if (!match) throw new Error('No se puede fijar el huso horario de la factura.')
  const offset = `${match[1]}${match[2].padStart(2, '0')}:${match[3] ?? '00'}`
  return {
    exercise: Number(parts.year), issueDate: `${parts.day}-${parts.month}-${parts.year}`,
    generatedAt: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
  }
}

function assertInvoice(input: LocalIssueInput): { details: FiscalDetail[]; totalCents: number; taxCents: number } {
  if (input.lines.length === 0 || !input.description.trim()) throw new Error('La factura carece de líneas o descripción.')
  if (input.invoiceType === 'F1' && !input.recipient) throw new Error('La factura completa requiere destinatario fiscal.')
  if (input.system.NumeroInstalacion !== (input.installationNumber ?? input.installationId)) throw new Error('La instalación no coincide con el registro fiscal.')
  const grouped = new Map<string, { base: number; tax: number }>()
  let totalCents = 0
  let taxCents = 0
  for (const line of input.lines) {
    if (!line.description.trim() || ![line.grossCents, line.discountCents, line.baseCents, line.taxCents].every(Number.isSafeInteger)) throw new Error('La línea fiscal contiene datos inválidos.')
    if (line.grossCents < 0 || line.discountCents < 0 || line.discountCents > line.grossCents
      || line.grossCents - line.discountCents !== line.baseCents + line.taxCents
      || line.baseCents < 0 || line.taxCents < 0) throw new Error('Los importes de la línea fiscal no cuadran.')
    if (!/^(4|10|21)\.00$/.test(line.taxRate)) throw new Error('El tipo de IVA no está soportado por la emisión local.')
    const divisor = BigInt(100 + Number.parseInt(line.taxRate, 10))
    const grossAfterDiscount = BigInt(line.grossCents - line.discountCents)
    const expectedBase = Number((grossAfterDiscount * 100n + divisor / 2n) / divisor)
    if (line.baseCents !== expectedBase) throw new Error('La base de IVA no corresponde al precio final y al tipo de la línea.')
    const row = grouped.get(line.taxRate) ?? { base: 0, tax: 0 }
    row.base += line.baseCents
    row.tax += line.taxCents
    grouped.set(line.taxRate, row)
    totalCents += line.baseCents + line.taxCents
    taxCents += line.taxCents
  }
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Total fiscal inválido.')
  const details = [...grouped].sort(([a], [b]) => Number(a) - Number(b)).map(([rate, row]) => ({
    Impuesto: '01' as const, ClaveRegimen: '01' as const, CalificacionOperacion: 'S1' as const,
    TipoImpositivo: rate, BaseImponibleOimporteNoSujeto: centsToAeat(row.base), CuotaRepercutida: centsToAeat(row.tax),
  }))
  return { details, totalCents, taxCents }
}

function assertProductionSaleMatchesInvoice(input: ProductionIssueInput, sale: SaleCreatedPayload, totalCents: number): void {
  if (sale.ticket.tenantId !== input.tenantId || sale.ticket.venueId !== input.venueId
    || sale.ticket.cashRegisterId !== input.cashRegisterId || sale.ticket.deviceId !== input.deviceId
    || sale.sale.totalCents !== totalCents || sale.ticket.totalCents !== totalCents
    || sale.lines.length !== input.lines.length) throw new Error('La venta y la factura fiscal no coinciden.')
  for (const [index, line] of sale.lines.entries()) {
    const fiscal = line.fiscalSnapshot
    const expected = input.lines[index]
    if (!fiscal || line.lineTotalCents !== expected.grossCents
      || (line.discountAmountCents ?? 0) !== expected.discountCents
      || fiscal.taxableBaseCents !== expected.baseCents || fiscal.taxAmountCents !== expected.taxCents
      || fiscal.taxRate.toFixed(2) !== expected.taxRate) throw new Error('Una línea no coincide con su instantánea fiscal.')
  }
}

/** Number, chain cursor, invoice, original record, delivery and sale are committed together. */
export async function issueLocalInvoice(input: LocalIssueInput, resolveSale?: ResolveFiscalSale): Promise<LocalFiscalEntry> {
  if (input.environment === 'test' && input.syntheticData !== true) throw new Error('Solo se admiten datos ficticios en el entorno de pruebas.')
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible. Se bloquea la emisión fiscal.')
  const scope = scopeKey(input)
  return navigator.locks.request(`tickit-fiscal:${scope}`, { mode: 'exclusive' }, async () => {
    await requestFiscalPersistentStorage()
    const db = await openLedger()
    try {
      const { details, totalCents, taxCents } = assertInvoice(input)
      if (input.environment === 'production') {
        assertFiscalLease(input.lease, input.installationId, input.deviceId, Date.now(), performance.now())
        const sale = input.salePayload
        if (sale.ticket.id !== input.ticketId || sale.sale.id !== input.saleId || (sale.payment?.id ?? null) !== input.paymentId
        ) {
          throw new Error('La venta y la factura fiscal no coinciden.')
        }
        assertProductionSaleMatchesInvoice(input, sale, totalCents)
      } else if (input.clockSample) assertFiscalClock(input.clockSample, Date.now(), performance.now())
      const time = localDateParts(new Date(), input.timezone)
      const series = fiscalSeries({ venueCode: input.venueCode, registerCode: input.registerCode, kind: input.invoiceType === 'F1' ? 'complete' : 'simplified', exercise: time.exercise })
      const { chain, number } = await loadCursors(db, scope, series)
      const nextNumber = number.lastNumber + 1
      if (!Number.isSafeInteger(nextNumber)) throw new Error('Contador fiscal agotado.')
      const seriesAndNumber = `${series}/${nextNumber}`
      const built = await createAltaRecord({
        invoice: { issuerNif: input.issuerNif, seriesAndNumber, issueDate: time.issueDate }, issuerName: input.issuerName,
        type: input.invoiceType, description: input.description, recipient: input.recipient, details, system: input.system,
        previous: chain.previous ? { IDEmisorFactura: chain.previous.issuerNif, NumSerieFactura: chain.previous.seriesAndNumber, FechaExpedicionFactura: chain.previous.issueDate, Huella: chain.previous.hash } : null,
         generatedAt: time.generatedAt, environment: input.qrEnvironment ?? input.environment,
      })
      const id = crypto.randomUUID()
      const entry: LocalFiscalEntry = {
        id, scope,
        record: {
          idempotencyKey: id, environment: input.environment, tenantId: input.tenantId, fiscalSubjectId: input.fiscalSubjectId,
          issuerNif: input.issuerNif, venueId: input.venueId, cashRegisterId: input.cashRegisterId,
          installationId: input.installationId, deviceId: input.deviceId, invoiceId: input.invoiceId,
          chainPosition: chain.position + 1, previous: chain.previous, hash: built.hash, generatedAt: time.generatedAt,
          canonicalSchema: 'aeat-registro-v1', canonicalRecord: built.canonicalRecord,
          ...(input.environment === 'production' ? { lease: { leaseId: input.lease.leaseId, fencingToken: input.lease.fencingToken } } : {}),
        },
        invoice: { issuerName: input.issuerName, issuerNif: input.issuerNif, issuerAddress: input.issuerAddress,
          series, number: nextNumber,
          issuedAt: time.generatedAt, qrUrl: built.qrUrl, ticketId: input.ticketId, saleId: input.saleId,
          paymentId: input.paymentId, lines: structuredClone(input.lines), recipient: input.recipient ?? null, totalCents, taxCents,
          transmissionMode: input.environment === 'production' ? input.transmissionMode : undefined },
        delivery: { state: 'LOCAL_PENDING', attempts: 0, lastError: null, nextAttemptAt: null, result: null },
      }
      let economicPayload = input.environment === 'production' ? input.salePayload : null
      if (resolveSale) {
        if (input.environment !== 'production') throw new Error('La resolución remota solo corresponde a ventas reales.')
        economicPayload = await resolveSale(entry)
        assertProductionSaleMatchesInvoice(input, economicPayload, totalCents)
        entry.invoice.ticketId = economicPayload.ticket.id
        entry.invoice.saleId = economicPayload.sale.id
        entry.invoice.paymentId = economicPayload.payment?.id ?? null
      }
      const tx = db.transaction(['cursors', 'numbers', 'bindings', 'entries', 'delivery', 'economicSales'], 'readwrite')
      const done = transactionDone(tx)
      const binding = await request(tx.objectStore('bindings').get(scope)) as DeviceBinding | undefined
      assertInstallationBinding(binding, input.deviceId)
      const savedChain = await request(tx.objectStore('cursors').get(scope)) as Cursor | undefined
      const savedNumber = await request(tx.objectStore('numbers').get(number.key)) as NumberCursor | undefined
      if ((savedChain?.position ?? 0) !== chain.position || (savedNumber?.lastNumber ?? 0) !== number.lastNumber) {
        tx.abort()
        throw new Error('La cadena o numeración cambió durante la emisión. Reintenta tras conciliar.')
      }
      tx.objectStore('cursors').put({ scope, position: entry.record.chainPosition, previous: { issuerNif: input.issuerNif, seriesAndNumber, issueDate: time.issueDate, hash: built.hash } } satisfies Cursor)
      tx.objectStore('numbers').put({ key: number.key, lastNumber: nextNumber } satisfies NumberCursor)
      tx.objectStore('bindings').put(binding ?? { scope, deviceId: input.deviceId } satisfies DeviceBinding)
      const { delivery, ...document } = entry
      tx.objectStore('entries').add(document satisfies StoredFiscalDocument)
      tx.objectStore('delivery').add({ id, ...delivery } satisfies StoredDelivery)
      if (input.environment === 'production') {
        if (!economicPayload) throw new Error('Falta la venta económica asociada al registro.')
        tx.objectStore('economicSales').add({ id, scope, payload: structuredClone(economicPayload),
          eventId: crypto.randomUUID(), synced: resolveSale !== undefined || input.economicAlreadySynced === true } satisfies StoredEconomicSale)
      }
      await done
      return entry
    } finally { db.close() }
  })
}

export async function issueSyntheticTestInvoice(input: TestIssueInput): Promise<LocalFiscalEntry> {
  return issueLocalInvoice(input)
}

export type LocalRectificativeLineSelection = { lineId: string; quantity: number; originalQuantity?: number }
export type LocalRectificativeInput = {
  installation: { tenantId: string; fiscalSubjectId: string; issuerNif: string; issuerName: string; venueId: string; cashRegisterId: string; venueCode: string; registerCode: string; installationId: string; deviceId: string; installationNumber?: string }
  lease?: FiscalLease
  original: LocalFiscalEntry
  type: 'R1' | 'R5'
  reason: string
  system: FiscalSystem
  timezone: string
  environment: 'test' | 'production'
  syntheticData?: true
  qrEnvironment?: 'test' | 'production'
  selectedLines?: readonly LocalRectificativeLineSelection[]
  refundRequestId?: string
}

export async function buildLocalRectificative(input: LocalRectificativeInput): Promise<LocalFiscalEntry> {
  if (!input.reason.trim()) throw new Error('La rectificativa requiere un motivo fiscal explícito.')
  if (input.environment === 'test' && input.syntheticData !== true) throw new Error('Solo se admiten datos ficticios en el entorno de pruebas.')
  if (input.environment === 'production' && !input.lease) throw new Error('La rectificativa requiere una autorización fiscal.')
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible. No se puede preparar la emisión fiscal.')
  if (input.original.record.tenantId !== input.installation.tenantId || input.original.record.fiscalSubjectId !== input.installation.fiscalSubjectId || input.original.record.installationId !== input.installation.installationId) throw new Error('La factura original no pertenece a esta instalación fiscal.')
  const scope = scopeKey(input.installation)
  return navigator.locks.request(`tickit-fiscal:${scope}`, { mode: 'exclusive' }, async () => {
    const db = await openLedger()
    try {
      const time = localDateParts(new Date(), input.timezone)
      const series = fiscalSeries({ venueCode: input.installation.venueCode, registerCode: input.installation.registerCode, kind: 'corrective', exercise: time.exercise, rectificative: true })
      const { chain, number } = await loadCursors(db, scope, series)
      const nextNumber = number.lastNumber + 1
      const hasSelections = Boolean(input.selectedLines)
      const lines = input.original.invoice.lines.flatMap((line, index) => {
        const lineId = (line as typeof line & { lineId?: string }).lineId ?? String(index)
        const selected = input.selectedLines?.find(item => item.lineId === lineId || item.lineId === String(index))
        const quantity = hasSelections ? selected?.quantity ?? 0 : 1
        const availableQuantity = selected?.originalQuantity ?? 1
        if (!Number.isInteger(quantity) || quantity < 0 || quantity > availableQuantity) throw new Error('La cantidad de rectificación debe ser un entero válido.')
        if (!quantity) return []
        const ratio = selected?.originalQuantity ? quantity / selected.originalQuantity : quantity
        return [{ ...line, grossCents: -Math.round(line.grossCents * ratio), discountCents: -Math.round(line.discountCents * ratio), baseCents: -Math.round(line.baseCents * ratio), taxCents: -Math.round(line.taxCents * ratio) }]
      })
      if (!lines.length) throw new Error('La rectificativa carece de líneas seleccionadas.')
      const details = [...new Set(lines.map(line => line.taxRate))].map(rate => ({ Impuesto: '01' as const, ClaveRegimen: '01' as const, CalificacionOperacion: 'S1' as const, TipoImpositivo: rate, BaseImponibleOimporteNoSujeto: centsToAeat(lines.filter(line => line.taxRate === rate).reduce((sum, line) => sum + line.baseCents, 0)), CuotaRepercutida: centsToAeat(lines.filter(line => line.taxRate === rate).reduce((sum, line) => sum + line.taxCents, 0)) }))
      const invoice = { issuerNif: input.installation.issuerNif, seriesAndNumber: `${series}/${nextNumber}`, issueDate: time.issueDate }
      const built = await createRectificativeRecord({ invoice, originalInvoice: { issuerNif: input.original.invoice.issuerNif, seriesAndNumber: `${input.original.invoice.series}/${input.original.invoice.number}`, issueDate: input.original.invoice.issuedAt.slice(0, 10).split('-').reverse().join('-') }, issuerName: input.installation.issuerName, type: input.type, description: input.reason, details, system: input.system, previous: chain?.previous ? { IDEmisorFactura: chain.previous.issuerNif, NumSerieFactura: chain.previous.seriesAndNumber, FechaExpedicionFactura: chain.previous.issueDate, Huella: chain.previous.hash } : null, generatedAt: time.generatedAt, environment: input.qrEnvironment ?? input.environment })
      const id = crypto.randomUUID()
      const totalCents = lines.reduce((sum, line) => sum + line.baseCents + line.taxCents, 0)
      const refundRequestId = input.refundRequestId ?? id
      return { id, scope, record: { ...input.original.record, idempotencyKey: id, invoiceId: id, chainPosition: chain.position + 1, previous: chain.previous, hash: built.hash, generatedAt: time.generatedAt, canonicalRecord: built.canonicalRecord }, invoice: { ...input.original.invoice, issuerName: input.installation.issuerName, issuerNif: input.installation.issuerNif, series, number: nextNumber, issuedAt: time.generatedAt, qrUrl: built.qrUrl, ticketId: refundRequestId, saleId: refundRequestId, paymentId: null, lines, totalCents, taxCents: lines.reduce((sum, line) => sum + line.taxCents, 0), transmissionMode: input.environment === 'production' ? 'bridge' : 'local-only' }, delivery: { state: 'LOCAL_PENDING', attempts: 0, lastError: null, nextAttemptAt: null, result: null } }
    } finally { db.close() }
  })
}

export async function persistLocalRectificative(entry: LocalFiscalEntry): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['cursors', 'numbers', 'bindings', 'entries', 'delivery'], 'readwrite')
    const done = transactionDone(tx)
    const series = entry.invoice.series
    tx.objectStore('cursors').put({ scope: entry.scope, position: entry.record.chainPosition, previous: { issuerNif: entry.record.issuerNif, seriesAndNumber: `${series}/${entry.invoice.number}`, issueDate: entry.invoice.issuedAt.slice(0, 10).split('-').reverse().join('-'), hash: entry.record.hash } } satisfies Cursor)
    tx.objectStore('numbers').put({ key: `${entry.scope}:${series}`, lastNumber: entry.invoice.number } satisfies NumberCursor)
    const { delivery, ...document } = entry
    tx.objectStore('entries').put(document satisfies StoredFiscalDocument)
    tx.objectStore('delivery').put({ id: entry.id, ...delivery } satisfies StoredDelivery)
    await done
  } finally { db.close() }
}

export async function issueLocalRectificative(input: LocalRectificativeInput): Promise<LocalFiscalEntry> {
  const entry = await buildLocalRectificative(input)
  await persistLocalRectificative(entry)
  return entry
}

export async function persistLocalFiscalAnnulment(input: {
  installation: {
    tenantId: string; fiscalSubjectId: string; issuerNif: string; venueId: string; cashRegisterId: string
    installationId: string; deviceId: string
  }
  lease: FiscalLease
  original: LocalFiscalEntry
  canonicalRecord: Awaited<ReturnType<typeof createAnulacionRecord>>['canonicalRecord']
  hash: string
  generatedAt: string
  reason: string
}): Promise<LocalFiscalEntry> {
  const { installation, lease, original } = input
  const scope = scopeKey(installation)
  if (original.scope !== scope || original.record.tenantId !== installation.tenantId
    || original.record.fiscalSubjectId !== installation.fiscalSubjectId
    || original.record.installationId !== installation.installationId) {
    throw new Error('La factura original no pertenece a esta instalación fiscal.')
  }
  assertFiscalLease(lease, installation.installationId, installation.deviceId, Date.now(), performance.now())
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible. Se bloquea la anulación fiscal.')
  return navigator.locks.request(`tickit-fiscal:${scope}`, { mode: 'exclusive' }, async () => {
    const db = await openLedger()
    try {
      const tx = db.transaction(['cursors', 'bindings', 'entries', 'delivery'], 'readwrite')
      const done = transactionDone(tx)
      const chain = await request(tx.objectStore('cursors').get(scope)) as Cursor | undefined
      const binding = await request(tx.objectStore('bindings').get(scope)) as DeviceBinding | undefined
      assertInstallationBinding(binding, installation.deviceId)
      if (!chain?.previous || chain.previous.hash !== original.record.hash) {
        tx.abort()
        throw new Error('Solo puede anularse la última factura de la cadena fiscal en esta V1.')
      }
      const id = crypto.randomUUID()
      const entry: LocalFiscalEntry = {
        id, scope,
        record: {
          idempotencyKey: id, environment: 'production', tenantId: installation.tenantId,
          fiscalSubjectId: installation.fiscalSubjectId, issuerNif: installation.issuerNif,
          venueId: installation.venueId, cashRegisterId: installation.cashRegisterId,
          installationId: installation.installationId, deviceId: installation.deviceId,
          invoiceId: original.record.invoiceId, chainPosition: chain.position + 1,
          previous: chain.previous, hash: input.hash, generatedAt: input.generatedAt,
          canonicalSchema: 'aeat-registro-v1', canonicalRecord: input.canonicalRecord,
          lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
        },
        invoice: structuredClone(original.invoice),
        annulment: { issuerName: original.invoice.issuerName, issuerNif: original.invoice.issuerNif,
          series: original.invoice.series, number: original.invoice.number, issuedAt: original.invoice.issuedAt,
          ticketId: original.invoice.ticketId, saleId: original.invoice.saleId, reason: input.reason },
        delivery: { state: 'LOCAL_PENDING', attempts: 0, lastError: null, nextAttemptAt: null, result: null },
      }
      tx.objectStore('cursors').put({ scope, position: entry.record.chainPosition, previous: {
        issuerNif: original.invoice.issuerNif, seriesAndNumber: `${original.invoice.series}/${original.invoice.number}`,
        issueDate: (input.canonicalRecord as { RegistroAnulacion: { IDFactura: { FechaExpedicionFacturaAnulada: string } } }).RegistroAnulacion.IDFactura.FechaExpedicionFacturaAnulada,
        hash: input.hash,
      } } satisfies Cursor)
      const { delivery, ...document } = entry
      tx.objectStore('entries').add(document satisfies StoredFiscalDocument)
      tx.objectStore('delivery').add({ id, ...delivery } satisfies StoredDelivery)
      await done
      return entry
    } finally { db.close() }
  })
}

export async function listLocalFiscalEntries(scopeInput: { tenantId: string; fiscalSubjectId: string; installationId: string }): Promise<LocalFiscalEntry[]> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['entries', 'delivery'], 'readonly')
    const done = transactionDone(tx)
    const entries = await request(tx.objectStore('entries').index('scope').getAll(scopeKey(scopeInput))) as StoredFiscalDocument[]
    const combined: LocalFiscalEntry[] = []
    for (const entry of entries) {
      const status = await request(tx.objectStore('delivery').get(entry.id)) as StoredDelivery | undefined
      if (!status) throw new Error('Falta el estado de un registro fiscal local.')
      const { id: _id, ...delivery } = status
      combined.push({ ...entry, delivery })
    }
    await done
    return combined.sort((a, b) => a.record.chainPosition - b.record.chainPosition)
  } finally { db.close() }
}

/** Restores a server-confirmed record without changing the original hash or number. */
export async function reconcileLocalFiscalCopies(
  scopeInput: { tenantId: string; fiscalSubjectId: string; installationId: string },
  deviceId: string, copies: readonly RestorableFiscalCopy[],
): Promise<number> {
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible para conciliar la cadena fiscal.')
  const scope = scopeKey(scopeInput)
  return navigator.locks.request(`tickit-fiscal:${scope}`, { mode: 'exclusive' }, async () => {
    const db = await openLedger()
    try {
      const tx = db.transaction(['cursors', 'numbers', 'bindings', 'entries', 'delivery', 'economicSales'], 'readwrite')
      const done = transactionDone(tx)
      const binding = await request(tx.objectStore('bindings').get(scope)) as DeviceBinding | undefined
      assertInstallationBinding(binding, deviceId)
      const local = await request(tx.objectStore('entries').index('scope').getAll(scope)) as StoredFiscalDocument[]
      const localByPosition = new Map(local.map(entry => [entry.record.chainPosition, entry]))
      let cursor = await request(tx.objectStore('cursors').get(scope)) as Cursor | undefined
      cursor ??= { scope, position: 0, previous: null }
      let restored = 0
      for (const copy of [...copies].sort((a, b) => a.entry.record.chainPosition - b.entry.record.chainPosition)) {
        const entry = copy.entry
        if (entry.scope !== scope || entry.record.tenantId !== scopeInput.tenantId
          || entry.record.fiscalSubjectId !== scopeInput.fiscalSubjectId
          || entry.record.installationId !== scopeInput.installationId
          || entry.record.deviceId !== deviceId || entry.record.environment !== 'production') {
          tx.abort(); throw new Error('El registro del servidor no pertenece a esta instalación fiscal.')
        }
        if (entry.record.chainPosition <= cursor.position) {
          const existing = localByPosition.get(entry.record.chainPosition)
          if (!existing || existing.id !== entry.id || existing.record.hash !== entry.record.hash) {
            tx.abort(); throw new Error('La cadena local difiere de la copia durable del servidor.')
          }
          continue
        }
        if (entry.record.chainPosition !== cursor.position + 1
          || entry.record.previous?.hash !== (cursor.previous?.hash ?? undefined)) {
          tx.abort(); throw new Error('Falta un registro anterior; se bloquea la conciliación fiscal.')
        }
        const recordRoot = entry.record.canonicalRecord.RegistroAlta ?? entry.record.canonicalRecord.RegistroAnulacion
        if (!recordRoot || typeof recordRoot !== 'object' || !('IDFactura' in recordRoot)
          || !recordRoot.IDFactura || typeof recordRoot.IDFactura !== 'object') {
          tx.abort(); throw new Error('La copia del servidor no contiene una identidad fiscal recuperable.')
        }
        const fiscalId = recordRoot.IDFactura as Record<string, unknown>
        const issueDate = fiscalId.FechaExpedicionFactura ?? fiscalId.FechaExpedicionFacturaAnulada
        if (typeof issueDate !== 'string') { tx.abort(); throw new Error('Falta fecha de expedición recuperable.') }
        const numberKey = `${scope}:${entry.invoice.series}`
        const number = await request(tx.objectStore('numbers').get(numberKey)) as NumberCursor | undefined
        if (entry.annulment === undefined && entry.invoice.number !== (number?.lastNumber ?? 0) + 1) {
          tx.abort(); throw new Error('La numeración local difiere de la copia durable del servidor.')
        }
        const { delivery, ...document } = entry
        tx.objectStore('entries').add(document satisfies StoredFiscalDocument)
        tx.objectStore('delivery').add({ id: entry.id, ...delivery } satisfies StoredDelivery)
        if (entry.annulment === undefined) tx.objectStore('numbers').put({ key: numberKey, lastNumber: entry.invoice.number } satisfies NumberCursor)
        if (copy.economicPayload) tx.objectStore('economicSales').put({ id: entry.id, scope,
          payload: copy.economicPayload, eventId: copy.eventId ?? crypto.randomUUID(), synced: true } satisfies StoredEconomicSale)
        const previousIdentity = fiscalId.NumSerieFactura ?? fiscalId.NumSerieFacturaAnulada
        cursor = { scope, position: entry.record.chainPosition,
          previous: { issuerNif: entry.invoice.issuerNif,
            seriesAndNumber: typeof previousIdentity === 'string' ? previousIdentity : `${entry.invoice.series}/${entry.invoice.number}`, issueDate, hash: entry.record.hash } }
        tx.objectStore('cursors').put(cursor)
        restored += 1
      }
      if (!binding && restored > 0) tx.objectStore('bindings').put({ scope, deviceId } satisfies DeviceBinding)
      await done
      return restored
    } finally { db.close() }
  })
}

export async function findLocalFiscalEntryByTicket(
  scopeInput: { tenantId: string; fiscalSubjectId: string; installationId: string }, ticketId: string,
): Promise<LocalFiscalEntry | null> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['entries', 'delivery'], 'readonly')
    const done = transactionDone(tx)
    const entry = await request(tx.objectStore('entries').index('ticket').get([scopeKey(scopeInput), ticketId])) as StoredFiscalDocument | undefined
    if (!entry) { await done; return null }
    const status = await request(tx.objectStore('delivery').get(entry.id)) as StoredDelivery | undefined
    if (!status) throw new Error('Falta el estado de la factura fiscal local.')
    await done
    const { id: _id, ...delivery } = status
    return { ...entry, delivery }
  } finally { db.close() }
}

export async function updateLocalFiscalDelivery(id: string, update: LocalFiscalEntry['delivery']): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction(['entries', 'delivery'], 'readwrite')
    const done = transactionDone(tx)
    const entry = await request(tx.objectStore('entries').get(id)) as StoredFiscalDocument | undefined
    if (!entry) { tx.abort(); throw new Error('Registro fiscal local no encontrado.') }
    tx.objectStore('delivery').put({ id, ...update } satisfies StoredDelivery)
    await done
  } finally { db.close() }
}

export async function listPendingFiscalEconomicSales(scopeInput: { tenantId: string; fiscalSubjectId: string; installationId: string }): Promise<StoredEconomicSale[]> {
  const db = await openLedger()
  try {
    const tx = db.transaction('economicSales', 'readonly')
    const done = transactionDone(tx)
    const stored = await request(tx.objectStore('economicSales').index('scope').getAll(scopeKey(scopeInput))) as StoredEconomicSale[]
    await done
    return stored.filter(sale => !sale.synced)
  } finally { db.close() }
}

export async function markFiscalEconomicSaleSynced(id: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('economicSales', 'readwrite')
    const done = transactionDone(tx)
    const sale = await request(tx.objectStore('economicSales').get(id)) as StoredEconomicSale | undefined
    if (!sale) { tx.abort(); throw new Error('Venta fiscal local no encontrada.') }
    tx.objectStore('economicSales').put({ ...sale, synced: true } satisfies StoredEconomicSale)
    await done
  } finally { db.close() }
}

export async function requestFiscalPersistentStorage(): Promise<boolean> {
  return Boolean(await navigator.storage?.persist?.())
}
