import { loadVerifactuIntegration } from './integration.ts'
import { assertRealSaleAllowedForMode, localFiscalMode, type LocalFiscalMode } from './mode.ts'

/** Installations and numbering also apply locally; activation only enables transport. */
export async function resolveLocalFiscalMode(tenantId: string): Promise<LocalFiscalMode> {
  const mode = localFiscalMode()
  assertRealSaleAllowedForMode(mode)
  if (mode === 'disabled') return mode
  await loadVerifactuIntegration(tenantId)
  return mode
}
