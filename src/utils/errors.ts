import { errorCode, reportOperationError, type OperationContext } from '../lib/observability.ts'
import { UserFacingError } from './UserFacingError.ts'
import { ZodError } from 'zod'

const expectedMessages: Record<string, string> = {
  invalid_credentials: 'El usuario o la contraseña no son correctos.',
  email_not_confirmed: 'Confirma tu correo antes de iniciar sesión.',
  user_already_exists: 'Ya existe una cuenta con ese correo.',
  UNIT_CONVERSION_REQUIRED: 'Configura la equivalencia entre las unidades antes de continuar.',
  INVALID_PRODUCTION_QUANTITY: 'Introduce una cantidad de producción válida.',
}

export function getReadableError(error: unknown, context: OperationContext = { operation: 'ui.operation' }, fallback = 'No se ha podido completar la operación. Inténtalo de nuevo; si el problema continúa, contacta con el responsable.') {
  if (error instanceof ZodError) return 'Revisa los campos del formulario antes de continuar.'
  if (error instanceof UserFacingError) {
    reportOperationError(error, context)
    return error.message
  }
  const code = errorCode(error) ?? (error instanceof Error ? error.message : '')
  if (expectedMessages[code]) return expectedMessages[code]
  reportOperationError(error, context)
  return fallback
}
