export type FiscalClockSample = {
  serverUtcAtReceipt: string
  wallUtcAtReceipt: number
  monotonicAtReceipt: number
}

/** Detects a moved iPad clock against a recent authenticated bridge time sample. */
export function assertFiscalClock(sample: FiscalClockSample, wallNow: number, monotonicNow: number): void {
  const serverAtReceipt = Date.parse(sample.serverUtcAtReceipt)
  const elapsed = monotonicNow - sample.monotonicAtReceipt
  if (![serverAtReceipt, sample.wallUtcAtReceipt, sample.monotonicAtReceipt, wallNow, monotonicNow].every(Number.isFinite)
    || elapsed < 0 || elapsed > 24 * 60 * 60 * 1000) {
    throw new Error('No hay una referencia horaria reciente y válida del puente fiscal.')
  }
  const expected = serverAtReceipt + elapsed
  if (Math.abs(wallNow - expected) > 2 * 60 * 1000) {
    throw new Error('El reloj del dispositivo difiere del puente fiscal. Se bloquea la expedición.')
  }
}

export type FiscalLease = {
  leaseId: string
  installationId: string
  deviceId: string
  fencingToken: number
  expiresAt: string
  clock: FiscalClockSample
  source?: 'bridge' | 'local-fallback'
}

/** Local fallback keeps the browser transaction usable while the transport is absent or unavailable. */
export function createLocalFallbackLease(installationId: string, deviceId: string): FiscalLease {
  const wallUtcAtReceipt = Date.now()
  const monotonicAtReceipt = performance.now()
  return {
    leaseId: `local-${crypto.randomUUID()}`,
    installationId,
    deviceId,
    fencingToken: wallUtcAtReceipt,
    expiresAt: new Date(wallUtcAtReceipt + 10 * 60 * 1000).toISOString(),
    clock: { serverUtcAtReceipt: new Date(wallUtcAtReceipt).toISOString(), wallUtcAtReceipt, monotonicAtReceipt },
    source: 'local-fallback',
  }
}

/** An expired or mismatched remote lease blocks issuance, including while offline. */
export function assertFiscalLease(lease: FiscalLease, installationId: string, deviceId: string, wallNow: number, monotonicNow: number): void {
  if (lease.installationId !== installationId || lease.deviceId !== deviceId || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1) {
    throw new Error('La concesión fiscal no corresponde a este dispositivo e instalación.')
  }
  assertFiscalClock(lease.clock, wallNow, monotonicNow)
  const expires = Date.parse(lease.expiresAt)
  const trustedNow = Date.parse(lease.clock.serverUtcAtReceipt) + monotonicNow - lease.clock.monotonicAtReceipt
  if (!Number.isFinite(expires) || trustedNow >= expires) throw new Error('La concesión exclusiva de la instalación ha expirado.')
}
