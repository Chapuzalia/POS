import { UserFacingError } from '../../../utils/UserFacingError.ts'

export type FiscalInstallationIdentity = {
  installationNumber: string
  venueCode: string
  registerCode: string
  installationCode: string
}

function compactUuid(value: string): string {
  const compact = value.replace(/-/g, '').toUpperCase()
  if (!/^[A-F0-9]{32}$/.test(compact)) throw new Error('La identidad de la caja no es válida.')
  return compact
}

/** Stable defaults are visible in CRM and unique for UUID-backed venue/register/device identities. */
export function defaultFiscalInstallationIdentity(
  venueId: string,
  cashRegisterId: string,
  deviceId: string,
): FiscalInstallationIdentity {
  return {
    installationNumber: `TICKIT-${deviceId.toUpperCase()}`,
    venueCode: `L${compactUuid(venueId).slice(-7)}`,
    registerCode: `C${compactUuid(cashRegisterId).slice(-7)}`,
    installationCode: `I${compactUuid(deviceId).slice(-7)}`,
  }
}

export function assertUniqueFiscalInstallationIdentities(
  installations: readonly (FiscalInstallationIdentity & { cashRegisterId: string; deviceId: string })[],
): void {
  const seen = new Map<string, number>()
  const fields = [
    ['installationNumber', 'número de instalación'],
    ['installationCode', 'código de instalación'],
    ['cashRegisterId', 'caja'],
    ['deviceId', 'dispositivo'],
  ] as const
  for (const [field, label] of fields) {
    seen.clear()
    installations.forEach((installation, index) => {
      const value = installation[field].trim().toUpperCase()
      const previous = seen.get(value)
      if (previous !== undefined) {
        throw new UserFacingError(`Las filas ${previous + 1} y ${index + 1} repiten ${label}. Cada instalación SIF debe ser exclusiva.`)
      }
      seen.set(value, index)
    })
  }
}

export function readableFiscalSetupError(error: unknown): UserFacingError {
  if (!error || typeof error !== 'object') return new UserFacingError('No se pudo guardar la configuración fiscal.')
  const value = error as { code?: unknown; details?: unknown; message?: unknown }
  const detail = [value.details, value.message].filter(item => typeof item === 'string').join(' ')
  if (value.code === '23505') {
    if (/installation_code|instalaci[oó]n.*code/i.test(detail)) {
      return new UserFacingError('Ese código de instalación ya fue utilizado por este titular fiscal. Introduce uno distinto; las identidades retiradas tampoco se reutilizan.')
    }
    if (/installation_number/i.test(detail)) {
      return new UserFacingError('Ese número de instalación ya fue utilizado por este titular fiscal. Introduce uno distinto.')
    }
    if (/cash_register/i.test(detail)) {
      return new UserFacingError('Esta caja ya tiene una instalación SIF activa en otro dispositivo. Usa el reemplazo controlado que aparece en su fila.')
    }
    if (/device/i.test(detail)) {
      return new UserFacingError('Este dispositivo ya tiene una instalación SIF activa. Recarga la configuración antes de volver a guardar.')
    }
    return new UserFacingError('Hay una identidad fiscal repetida. Cada caja, dispositivo, número y código de instalación deben ser exclusivos.')
  }
  if (typeof value.message === 'string' && value.message) return new UserFacingError(value.message)
  return new UserFacingError('No se pudo guardar la configuración fiscal.')
}
