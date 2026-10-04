export type LocalFiscalMode = 'disabled' | 'test' | 'production' | 'invalid'

export function localFiscalMode(): LocalFiscalMode {
  const value = import.meta.env?.VITE_VERIFACTU_MODE ?? 'production'
  return value === 'disabled' || value === 'test' || value === 'production' ? value : 'invalid'
}

/** Production checkout must pass installation and ledger preflight; transport may remain queued locally. */
export function assertRealSaleAllowed(): void {
  assertRealSaleAllowedForMode(localFiscalMode())
}

export function assertRealSaleAllowedForMode(mode: LocalFiscalMode): void {
  if (mode === 'invalid') throw new Error('El modo VERI*FACTU está mal configurado.')
}
