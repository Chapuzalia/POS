export type LocalFiscalMode = 'disabled' | 'test' | 'production' | 'invalid'

export function localFiscalMode(): LocalFiscalMode {
  const value = import.meta.env?.VITE_VERIFACTU_MODE ?? 'production'
  return value === 'disabled' || value === 'test' || value === 'production' ? value : 'invalid'
}

/** Production checkout must still pass the installation, ledger and bridge lease preflight. */
export function assertRealSaleAllowed(): void {
  assertRealSaleAllowedForMode(localFiscalMode())
}

export function assertRealSaleAllowedForMode(mode: LocalFiscalMode): void {
  if (mode === 'test' || mode === 'invalid') throw new Error(mode === 'test'
    ? 'Modo VERI*FACTU de pruebas: los cobros reales están bloqueados. Usa solo datos ficticios.'
    : 'El modo VERI*FACTU está mal configurado.')
}
