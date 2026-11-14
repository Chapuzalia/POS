import { assertRealSaleAllowedForMode, localFiscalMode, type LocalFiscalMode } from './mode.ts'

/** Installations and numbering also apply locally; activation only enables transport. */
export async function resolveLocalFiscalMode(_tenantId: string): Promise<LocalFiscalMode> {
  const mode = localFiscalMode()
  assertRealSaleAllowedForMode(mode)
  return mode
}
